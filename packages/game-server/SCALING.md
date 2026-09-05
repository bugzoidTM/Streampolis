# City AOI e processos Colyseus

O servidor mantém todos os corpos e resolve movimento/colisão em 24 Hz. A
`CityRoom` usa `StateView` do Colyseus 0.16 para enviar a cada cliente apenas
os corpos próximos: entram até 24 m, continuam visíveis até 28 m. A diferença
evita reapresentar um avatar inteiro repetidamente quando ele oscila na borda.
O próprio jogador sempre recebe seu estado. Os limites são configuráveis por
`CITY_AOI_RADIUS` e `CITY_AOI_LEAVE_RADIUS`; a segunda distância deve ser maior
ou igual à primeira.

`CityState.players` é a visão espacial; `CityState.members` é a lista social,
sem posições, compartilhada com toda a sala. A lista de pessoas e os retratos
do chat usam `members`, inclusive para quem está longe. Chat, bloqueios,
moderação, lotação e diretório da API continuam operando sobre sessões reais.
Sair do raio não significa sair da praça. Uma saída real remove o corpo de
cada `StateView` antes de soltar sua referência do estado; isto também cobre
a troca de aba do mesmo usuário. Mudanças de roupa atualizam os dois estados.

O schema da cidade é separado de `WorldState`: os schemas 3.x não permitem
redecorar campos herdados com segurança. Apartamento e live conservam a
serialização compartilhada; espectadores continuam sem corpo. Os quatro
campos iniciais da cidade conservam a ordem do antigo `WorldState`.

Com a lotação padrão de 36, a atualização custa no máximo 1.296 comparações
simples por tick. A quantidade de bytes depende da distribuição espacial: um
grupo reunido continua recebendo todos os corpos próximos. O filtro adiciona
codificação por cliente, portanto esta implementação não afirma suportar
centenas de pessoas por shard nem substitui um teste de carga.
O teto vem da menor capacidade entre a cena e `CITY_CAPACITY`; o campo
`capacity` enviado por um cliente no matchmaking é ignorado.

## Redis e roteamento

Sem `REDIS_URL`, o desenvolvimento usa Presence/Driver locais. Com Redis, usa
`@colyseus/redis-presence@0.16.4` e `@colyseus/redis-driver@0.16.1`, da mesma
linha 0.16 do core. Redis configurado e indisponível nunca cai silenciosamente
para memória local. `GAME_SERVER_DISTRIBUTED=1` exige Redis; `REDIS_URL` exige
`GAME_SERVER_PUBLIC_ADDRESS`, no formato `host[:port]/caminho`, sem `wss://`.

A reserva HTTP pode chegar em qualquer worker. O SDK usa o `publicAddress`
retornado para abrir o WebSocket no processo dono da sala. Por isso somente
mudar `replicas: 1` para `replicas: 2` no serviço antigo quebra o jogo.

O overlay `deploy/stack.scaling.yml` cria duas instâncias identificáveis,
Redis privado e um gateway nginx. O domínio e o endereço inicial `/ws`
continuam os mesmos; os sockets usam `/ws/1/...` ou `/ws/2/...`. Cada worker
fica com uma réplica. O gateway balanceia matchmaking e encaminha os caminhos
dos workers diretamente. Redis não tem porta publicada nem acesso à rede
compartilhada Nutef; guarda somente coordenação efêmera, sem persistência.
API/Postgres continuam responsáveis pelo patrimônio e pelos pagamentos.

O `/health` de cada worker retorna 503 enquanto não está aceitando ou quando
as conexões Redis Presence/Driver não respondem; informa `processId`,
`serverId` e modo. A presença social da API continua por retratos completos
independentes por worker. O overlay define ids distintos; instalações novas
podem omitir `GAME_SERVER_ID` para obter um id por processo.

## Validar antes de ativar

```bash
npm run test --workspace @streampolis/game-server
npm run e2e:shard --workspace @streampolis/game-server

# Redis DESCARTÁVEL dedicado ao teste. Nunca use Redis da produção.
REDIS_URL=redis://127.0.0.1:16379 npm run e2e:scaling --workspace @streampolis/game-server
```

O smoke sobe dois processos Node e um proxy local em `2610`, `2611`, `2612`
(`E2E_SCALING_PORT` altera a primeira porta). Ele verifica ids distintos,
distribuição de salas, endereços por worker, `joinById` solicitado ao outro
processo, chat, capacidade, isolamento de shards e continuidade do worker
sobrevivente após encerramento do outro. Não toca a API nem contas reais.
Encerra seus processos ao final. Deve rodar contra Redis real; mocks não
demonstram coordenação entre processos.

Validação de 05/09/2026: 69 testes e o smoke completo passaram em Linux com
Node 22 e Redis 8.2.3 real, em containers descartáveis numa rede Docker interna,
sem portas publicadas. A composição base + overlay passou em `docker stack
config`; `game-nginx.conf` passou em `nginx -t`. O overlay fixa pelo digest
a mesma imagem Redis 8.2.3 exercitada nesse smoke, já disponível na VPS.

Na VPS, uma validação isolada pode usar uma rede Docker temporária e Redis
sem portas publicadas; o container Node que executa o smoke deve montar uma
cópia de teste do checkout e seu próprio `node_modules`. O namespace Redis
deve ser exclusivo: Colyseus 0.16 usa nomes de canais e chaves globais.

## Ativação e retorno

Depois de instalar dependências e compilar, a composição é:

```bash
docker stack config -c deploy/stack.yml -c deploy/stack.scaling.yml
docker stack deploy -c deploy/stack.yml -c deploy/stack.scaling.yml streampolis
```

Carregue os segredos da stack como descrito em `deploy/README.md`. Revise a
composição antes de executar: `sp-game` deve ter `traefik.enable=false`; o
gateway é o único serviço com a rota `/ws`. Verifique `/ws/1/health`,
`/ws/2/health`, login e encontro de dois jogadores no mesmo `roomId`.

O rollout reinicia o game server: sessões existentes reconectam e não são
migradas entre processos. Processe uma janela de manutenção se necessário.
Salas não têm failover transparente: se um worker morre, somente as salas dele
são perdidas. Redis único também é ponto de falha; o overlay é expansão de
capacidade, não alta disponibilidade. A API permanece uma réplica porque o
diretório social ainda é agregado em memória nela.

Para retornar, reaplique somente `deploy/stack.yml` e remova os três serviços
opcionais (`streampolis_sp-game-2`, `streampolis_sp-game-gateway`,
`streampolis_sp-redis`) após confirmar o retorno da rota antiga. `stack deploy`
sem `--prune` não remove serviços omitidos; deixar o gateway antigo mantém duas
definições concorrentes da mesma rota Traefik. Não use `--prune` contra uma
composição parcial da stack.

Referências oficiais da versão implementada:
[StateView 0.16](https://0-16-x.docs.colyseus.io/state/view),
[escalabilidade e publicAddress](https://0-16-x.docs.colyseus.io/deployment/scalability).
