# Produção — streampolis.nutef.com

Rodando na VPS da Nutef, em Docker Swarm atrás do Traefik que já serve os outros
domínios da casa.

A stack tem **dois modos de entrada**, e o modo é o terceiro arquivo do comando
de deploy:

| Modo | Comando | Quem entra |
| --- | --- | --- |
| **Public Beta** | `-c stack.yml -c stack.scaling.yml -c stack.beta.yml` | só quem se cadastra ou faz login com senha |
| **Demonstração** | `-c stack.yml -c stack.scaling.yml -c stack.demo.yml` | qualquer um, escolhendo um personagem na fileira |

A base (`stack.yml`) já vem FECHADA (`NODE_ENV=production`, `API_DEV_LOGIN=0`):
esquecer um overlay tem de custar a fileira de personagens, que se vê no
primeiro segundo, e não abrir a entrada sem senha, que não se vê nunca. Cada
overlay explica o que muda; comece por eles.

## Desenho

Um domínio só, três caminhos:

```
https://streampolis.nutef.com/          → sp-site  (nginx, build do Vite)
https://streampolis.nutef.com/api/*     → sp-api   (Express, Postgres)
wss://streampolis.nutef.com/ws/*        → sp-game  (Colyseus)
```

Um domínio é decisão, não preguiça: a API vira mesma-origem para o site (CORS
sai do caminho crítico) e um certificado basta. O Traefik tira o prefixo
(`stripprefix`) antes de repassar, então a API continua vendo `/lives` e o
Colyseus continua vendo `/matchmake/...` — nenhum dos dois sabe que mora num
subcaminho.

Os serviços se chamam `sp-*` **de propósito**: a rede `Nutef` é compartilhada
por todas as stacks da máquina e o nome curto do serviço vira DNS nela. Um
serviço chamado `api` ou `db` aqui roubaria (ou herdaria) o endereço de outra
stack — já aconteceu nesta VPS.

## Segredos

Ficam FORA do repositório, em `/root/streampolis-deploy/.env` (modo 600):

```
SP_DB_PASSWORD=…      senha do Postgres da stack
SP_JWT_SECRET=…       assina o token de sessão; o game server verifica com ele
SP_SERVICE_TOKEN=…    game server → /internal/* da API
SP_WEBHOOK_SECRET=…   webhook de pagamento (ainda não usado)
```

## Subir / atualizar

```bash
# 1. build do cliente com os endereços de produção
cd /root/streampolis
VITE_API_URL=https://streampolis.nutef.com/api \
VITE_GAME_SERVER_URL=wss://streampolis.nutef.com/ws \
npm run build --workspace @streampolis/client

# 2. game server compilado (o serviço roda o dist/)
npm run build --workspace @streampolis/game-server

# 3. stack — o TERCEIRO arquivo escolhe o modo de entrada
cd /root/streampolis-deploy && set -a && . ./.env && set +a
docker stack deploy -c /root/streampolis/deploy/stack.yml \
  -c /root/streampolis/deploy/stack.scaling.yml \
  -c /root/streampolis/deploy/stack.demo.yml streampolis   # ou stack.beta.yml
```

A ordem importa: `stack.scaling.yml` antes do overlay de modo, porque é ele que
define `sp-game-2`. Para ver o que o Swarm vai receber sem publicar nada:

```bash
docker stack config -c stack.yml -c stack.scaling.yml -c stack.beta.yml \
  | grep -E 'NODE_ENV|API_DEV_LOGIN'
```

O site é servido por bind mount de `packages/client/dist`: refazer o build já
publica, sem redeploy. A API e o game server rodam o código do repositório
montado em `/app` — mudar código exige `docker service update --force`.

Desde a atualização de movimento de 05/09/2026, a produção usa o overlay de
escala: dois workers, gateway e Redis privado. Mantenha os DOIS arquivos na
atualização; aplicar somente a base não remove o gateway e deixa rotas
concorrentes. Reinicie ambos os workers quando apenas o código mudar.
Consulte `packages/game-server/SCALING.md` para operação e rollback completo.
Verifique `/ws/1/health` e `/ws/2/health` depois de publicar.

## Banco

O Postgres da produção é o serviço `sp-db` (volume `streampolis_sp_pgdata`),
separado do container de desenvolvimento em `127.0.0.1:55432`. Migrar e semear
se faz de dentro do container da API, que já está na rede e com o repo montado:

```bash
CID=$(docker ps --filter name=streampolis_sp-api -q | head -1)
source /root/streampolis-deploy/.env
docker exec -e DATABASE_URL="postgres://streampolis:${SP_DB_PASSWORD}@sp-db:5432/streampolis" \
  -w /app/packages/api $CID node src/db/migrate.ts
```

## A porta de entrada: qual é a aberta e qual é a fechada

`POST /auth/dev-login` entra por username, sem senha. É a porta da demonstração,
e ela existe **só** onde a API não roda com `NODE_ENV=production` — nenhuma linha
de código muda entre os dois modos, só o ambiente:

```
NODE_ENV=production     # dev-login some, e o segredo default deixa de existir
API_DEV_LOGIN=0         # cinto e suspensório
```

Com ela fechada, a tela de entrada some sozinha com a fileira de personagens
(ela desenha o que `/auth/demo-accounts` responder) e sobra só o formulário de
cadastro e login. O cadastro (`POST /auth/register`) funciona nos dois modos.

Mesmo com a porta aberta, ela só abre conta de **fixture** (as do `seed`,
domínio `@dev.streampolis`): quem se cadastra de verdade na demonstração não
aparece na fileira nem pode ser aberto por username.

Duas consequências do modo beta que costumam pegar de surpresa:

* `npm run seed` **recusa-se a rodar** em produção — conta com senha conhecida
  não tem o que fazer numa beta pública. Semear é coisa do modo demonstração;
* todas as ferramentas de conferência do repositório (`tools/*-check.mjs`, os
  `e2e:*` do game server) entram por `dev-login` e portanto **só funcionam no
  modo demonstração**. A exceção — e o que se roda antes de publicar uma beta —
  é o `release-check` abaixo.

## Compra de Coins (checkout)

O fluxo do PRD §15 — dinheiro real → Coins → presente — existe na API desde
06/09/2026:

```
GET  /shop/coin-packages              vitrine (pública, com o aviso legal)
POST /me/checkout                     abre a intenção de compra (pendente)
POST /payments/webhook/:provider      o provedor confirma; SÓ aqui a moeda entra
GET  /me/payments                     histórico do jogador
```

Quem credita é o **webhook**, nunca o navegador, e ele é autenticado pela
assinatura HMAC-SHA256 do corpo CRU no header `X-Streampolis-Signature`
(`sha256=…` também é aceito), com o `SP_WEBHOOK_SECRET` do `.env`. Evento
repetido é normal num gateway: a dedupe está em `webhook_events` e na chave de
idempotência do pagamento.

O provedor é configuração, e o padrão é **não ter**:

| `PAYMENTS_PROVIDER` | efeito |
| --- | --- |
| `none` (padrão) | `/me/checkout` responde 503 "indisponível". É a verdade enquanto não houver gateway contratado — melhor do que uma tela de pagamento que não cobra |
| `sandbox` | provedor de mentira, com `POST /payments/sandbox/:id/confirm`. **Proibido em produção** (a API se recusa a subir); é o que permite o `release-check` comprar Coins de ponta a ponta |

Ligar um gateway de verdade é implementar um adaptador que devolva
`{ providerPaymentId, checkoutUrl }` em `packages/api/src/shop/Checkout.ts`; o
webhook, o crédito e a idempotência já estão prontos para ele. Defina também
`PAYMENTS_RETURN_URL=https://streampolis.nutef.com` para a volta do checkout.

## Verificar

```bash
node tools/prod-check.mjs                      # primeira visita, entrar, mundo
node tools/screens-check.mjs --client=https://streampolis.nutef.com \
  --api=https://streampolis.nutef.com/api --server=wss://streampolis.nutef.com/ws
```

Os dois entram por `dev-login`: valem no modo **demonstração**.

### admin-check (moderação e economia)

Fila de denúncias, dossiê, sanção com motivo obrigatório, ajuste de saldo,
bloqueio de carteira, pacotes de Coins e o rastro no audit log — mais a metade
que costuma faltar: o efeito no jogo (quem é silenciado realmente para de falar
na sala; carteira bloqueada realmente não compra).

```bash
npm run admin:check
```

A equipe entra com **senha** (`/auth/login`), nunca por `dev-login`: a porta
aberta da demonstração serve para experimentar o jogo, e desde que o painel
existe ela abriria poder de banir e de mexer em saldo para qualquer visitante.
`dev-login` responde 404 para conta de moderador ou administrador.

Papéis: **moderador** vê a fila e aplica sanções; **administrador** faz o que é
dinheiro — ajustar saldo, bloquear carteira, configurar pacotes. Silenciar
alguém por uma hora e creditar 10.000 Coins têm raios de explosão diferentes.

As contas de equipe da produção (`moderador`, `administrador`) têm senha
ALEATÓRIA, guardada em `SP_STAFF_PASSWORD` no `/root/streampolis-deploy/.env`.
A senha do `seed` (`streampolis-dev`) está escrita no repositório e valia nelas
até 06/09/2026 — com o painel no ar, isso era acesso público à moderação. Se
rodar o `seed` de novo contra a produção, ele reescreve essas senhas para a de
desenvolvimento: rotacione depois.

```bash
# admin-check contra a produção
source /root/streampolis-deploy/.env
STAFF_PASSWORD="$SP_STAFF_PASSWORD" node tools/admin-check.mjs \
  --api=https://streampolis.nutef.com/api --ws=wss://streampolis.nutef.com/ws/1
```

### release-check (o que se roda antes de publicar a beta)

Duas contas novas, criadas pelo formulário, fazendo a volta inteira: cadastro,
avatar, praça, amizade, encontrar, apartamento, live, gift e PK. Não usa
`dev-login` em lugar nenhum, então é o único que vale nos dois modos.

```bash
# local (API e game server de desenvolvimento)
npm run release:check

# contra a stack publicada, de dentro do container da API — é lá que o
# Postgres da produção é alcançável (com PAYMENTS_PROVIDER=none o release-check
# credita a conta de teste por dentro; com um provedor configurado ele COMPRA)
CID=$(docker ps --filter name=streampolis_sp-api -q | head -1)
source /root/streampolis-deploy/.env
docker exec -w /app \
  -e DATABASE_URL="postgres://streampolis:${SP_DB_PASSWORD}@sp-db:5432/streampolis" \
  $CID node tools/release-check.mjs --expect=beta \
    --api=http://sp-api:8787 --ws=ws://sp-game:2567
```

Duas coisas a saber antes de rodar:

* em produção o limitador deixa passar 10 chamadas de `/auth` por minuto por IP
  e a rodada gasta 6 — **espere um minuto entre duas rodadas**, senão o cadastro
  volta 429 (o limitador funcionando, não um defeito);
* cada rodada **deixa duas contas** `rc_<carimbo>_a/_b` no banco. É de propósito:
  gift e PK escrevem em `wallet_transactions` e `pk_matches`, que referenciam o
  usuário com `ON DELETE RESTRICT` porque extrato e histórico são imutáveis.
  Apagar a conta exigiria apagar o extrato.

Com `--ws` apontando para o domínio público, use **um worker fixo**
(`wss://streampolis.nutef.com/ws/1`): "Encontrar" entra numa sala pelo id, e o id
só existe no worker que a criou.

## DNS

`CNAME streampolis.nutef.com → vps.nutef.com`, sem proxy da Cloudflare (cinza),
igual aos outros subdomínios da casa. O certificado é do Let's Encrypt via
desafio HTTP-01 do próprio Traefik.
