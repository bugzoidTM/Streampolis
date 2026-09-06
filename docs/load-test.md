# Teste de carga — 72 jogadores e uma live cheia

Medição de 06/09/2026 contra a produção de dois workers (`stack.yml` +
`stack.scaling.yml` + `stack.demo.yml`), pelo domínio público, com
`node tools/load-test.mjs --players=72 --viewers=100 --seconds=180`.

O que estava no ar ao mesmo tempo:

* **72 jogadores** na Praça Central, andando a 24 Hz (a mesma cadência do
  cliente de verdade: `WorldConnection` manda uma intenção por passo fixo, e o
  passo fixo é `TICK_HZ = 24`). Lotação de 36 por shard ⇒ **2 shards**;
* **1 live** com **100 espectadores** e 60 mensagens de chat por minuto;
* 173 sessões WebSocket no total, todas com token assinado como o da API.

## O que este teste achou (e que os números não mostravam)

Na primeira rodada o servidor parecia folgado — 15% de um núcleo, event loop
com p99 de 4 ms, zero quedas — e o cliente estava **recebendo estado
corrompido**: 72.364 erros `"refId" not found` em 60 s de praça.

A causa é o buffer de codificação do `@colyseus/schema`, que vem com 8 KB
(`Buffer.poolSize`). A praça filtra corpos por proximidade (`StateView`), e uma
sala com N pessoas codifica **N visões no mesmo buffer compartilhado**: o custo
cresce com o quadrado da lotação. Com 8 pessoas nada estoura; com 36 estoura em
quase todo quadro em que a maioria anda. Quando estoura, a biblioteca avisa em
`console.warn` e **redimensiona o buffer no meio da codificação** — o que sai
para o navegador depois disso é fluxo corrompido.

O modo de falha é o pior que existe: o socket não cai, `onError` não dispara,
o log de aplicação do servidor não registra nada. O jogador continua conectado
vendo uma praça que não existe.

Foi isolado assim (tudo em `tools/load-test.mjs --only=…`):

| cenário | erros de decodificação |
| --- | --- |
| live com 100 espectadores, 60 s (sem `StateView`) | **0** |
| 72 jogadores na praça, 60 s | **72.364** |
| 36 jogadores parados | 0 |
| 2 e 8 jogadores andando | 0 |

Correção: `Encoder.BUFFER_SIZE = 256 * 1024` em `packages/game-server/src/index.ts`,
antes de qualquer sala nascer. 64 KB **não bastaram** (o aviso pediu 72 KB no
pico e dois estouros em 3 min produziram 881 erros); 256 KB são ~3,5× o pico
observado, ao custo de um quarto de megabyte por sala.

Se a lotação do shard subir (`CITY_CAPACITY`), este número sobe junto. O sinal
está no log do worker:

```bash
docker service logs --since 30m streampolis_sp-game | grep -c "buffer overflow"
```

## Números da rodada final (janela de 182 s, já com a correção)

Medidos **de dentro do processo** (`/health`), porque o driver roda na mesma
máquina e qualquer medida de host mediria o driver junto.

| worker | salas | conexões | CPU (de 1 núcleo) | RSS | lag p50 | lag p99 | lag máx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sp-game-1 | 1 (praça) | 36 | **8,9 %** | 120 MB | 0,1 ms | 2,2 ms | 30,9 ms |
| sp-game-2 | 2 (praça + live) | 137 | **15,5 %** | 127 MB | 0,1 ms | 3,6 ms | 40,6 ms |

Banda, pelos contadores de rede dos containers:

| container | entrada | saída | por cliente (saída) |
| --- | --- | --- | --- |
| sp-game (1 shard de 36) | 113 KB/s | 154 KB/s | ~4,3 KB/s por jogador |
| sp-game-2 (1 shard + live de 101) | 253 KB/s | 332 KB/s | ~1,8 KB/s por espectador |
| sp-game-gateway (proxy, conta os dois lados) | 852 KB/s | 852 KB/s | — |
| sp-api (presença, onboarding) | 1,7 KB/s | 0,1 KB/s | — |
| sp-db | ~0 | ~0 | — |

Saída total na borda: **≈ 486 KB/s (3,9 Mbps) para 173 jogadores**.

* **Quedas espontâneas: 0.** Nenhum cliente caiu sozinho em nenhuma das rodadas.
* **Recusas de entrada: 0.** 72/72 e 100/100 entraram.
* **Erros de decodificação: 0** (eram 72.364 antes da correção).
* CPU dos containers pelo `docker stats`, para comparação: mediana 8,5 % e 15,0 %
  nos workers, 18,6 % no gateway nginx — o proxy custa mais CPU que qualquer
  worker, porque ele transporta os dois lados de tudo.

## Leitura

**O gargalo não é CPU, RAM nem banda.** Nos dois workers somados, a carga toda
ocupou menos de um quarto de um núcleo dos oito da máquina, e o event loop
ficou em 0,1 ms de mediana com um teto de 41 ms — um tick de 24 Hz tem 41 ms de
orçamento, então o pior quadro medido gastou um tick e nenhum se perdeu.

O que limita é a **serialização por visão da praça**, que cresce com o quadrado
da lotação do shard. É por isso que a resposta certa foi o buffer, e não mais
CPU: o custo já estava sendo pago, ele só não cabia no lugar onde era escrito.

Duas observações operacionais que não viraram mudança:

* **Distribuição desigual entre workers.** O segundo shard da praça e a live
  foram parar no mesmo processo (137 conexões contra 36). O gateway balanceia o
  *matchmaking*, não a propriedade das salas — quem cria a sala fica com ela.
  Nesta carga não fez diferença (15,5 % de um núcleo); numa carga 10× maior,
  faria.
* **Pico de `lagMax` subiu** de 13/24 ms para 31/41 ms depois da correção, e a
  suspeita é a alocação dos buffers maiores na criação das salas — acontece uma
  vez por sala, durante a entrada, e não no regime (o p99 melhorou de 4,0 para
  3,6 ms).

## Como repetir

```bash
set -a && . /root/streampolis-deploy/.env && set +a
node tools/load-test.mjs --players=72 --viewers=100 --seconds=180
```

Precisa de `SP_JWT_SECRET` (os tokens são assinados localmente: passar 173
sessões por `/auth` mediria o limitador, não o jogo) e do Docker, para criar e
apagar as contas dentro do container da API — as contas de carga são removidas
no fim de cada rodada.

Para 100 espectadores **além** do anfitrião é preciso subir o teto da sala
antes, porque `LIVE_CAPACITY=100` conta o anfitrião:

```bash
docker service update --env-add LIVE_CAPACITY=128 streampolis_sp-game
docker service update --env-add LIVE_CAPACITY=128 streampolis_sp-game-2
# … rodar o teste …
docker service update --env-rm LIVE_CAPACITY streampolis_sp-game
docker service update --env-rm LIVE_CAPACITY streampolis_sp-game-2
```

Repro local do defeito de codificação, sem produção e sem banco (um servidor em
`2600` e 36 clientes andando): `node tools/_aoi-repro.mjs`.
