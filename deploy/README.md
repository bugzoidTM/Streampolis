# Produção — streampolis.nutef.com

Demonstração pública rodando na VPS da Nutef, em Docker Swarm atrás do Traefik
que já serve os outros domínios da casa.

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

# 3. stack
cd /root/streampolis-deploy && set -a && . ./.env && set +a
docker stack deploy -c /root/streampolis/deploy/stack.yml streampolis
```

O site é servido por bind mount de `packages/client/dist`: refazer o build já
publica, sem redeploy. A API e o game server rodam o código do repositório
montado em `/app` — mudar código exige `docker service update --force`.

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

## A porta de entrada é aberta, de propósito

Ainda não existe cadastro. O site entra por personagem (`POST /auth/dev-login`),
o que só funciona porque a API **não** roda com `NODE_ENV=production` — lá essa
rota não existe. Antes de valer dinheiro de verdade: cadastro, senha, e
`API_DEV_LOGIN` desligado.

## Verificar

```bash
node tools/prod-check.mjs                      # primeira visita, entrar, mundo
node tools/screens-check.mjs --client=https://streampolis.nutef.com \
  --api=https://streampolis.nutef.com/api --server=wss://streampolis.nutef.com/ws
```

## DNS

`CNAME streampolis.nutef.com → vps.nutef.com`, sem proxy da Cloudflare (cinza),
igual aos outros subdomínios da casa. O certificado é do Let's Encrypt via
desafio HTTP-01 do próprio Traefik.
