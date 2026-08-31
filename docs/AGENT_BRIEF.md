# Streampolis — briefing de engenharia

Leia isto antes de tocar em qualquer arquivo. O PRD e as SPECs estão na raiz do
repositório (`STREAMPOLIS PRD.md`, `STREAMPOLIS SPECs.md`) e são a autoridade
sobre o produto. Este documento só cobre convenções de código.

## Onde as coisas vivem

```
packages/shared/src/      tipos, catálogos (gifts/items), protocolo de rede
packages/client/src/
  game/                   engine Three.js (Renderer, Environment, QualityManager)
  game/avatar/            Skeleton, Loft, BodyBuilder, Wardrobe, Materials, Avatar
  game/materials/         Noise.ts, Textures.ts (PBR procedural)
  game/scenes/            cenas do mundo
  game/anim/              clipes e máquina de estados de animação
  game/fx/                shaders e efeitos
  network/                clientes Colyseus
  ui/                     React (HUD, chat, loja, feed, perfil)
  state/                  stores Zustand
  lab/                    cenas de teste usadas pela revisão visual
packages/game-server/     Colyseus
packages/api/             API REST + economia + Postgres
tools/                    shoot.mjs (screenshot), probe.mjs (dump de estado)
```

## Como rodar o jogo inteiro

Três processos, e só o primeiro é obrigatório para ver a cidade:

```
npm run dev --workspace @streampolis/client        # Vite em :5273
npm run dev --workspace @streampolis/game-server   # Colyseus em :2567
npm run e2e --workspace @streampolis/game-server   # prova do §69, sem navegador
```

Sem `?token=`, o cliente roda **offline**: mesma praça, mesma câmera, avatar
local integrado pela mesma `applyMoveIntent` do servidor. Com o game server no
ar, `http://127.0.0.1:5273/?view=world&token=ana&name=Ana` entra de verdade (o
token de desenvolvimento É o id do usuário enquanto a API não emite os reais).
`?view=lab` continua abrindo o laboratório de avatares.

## Quem manda em quê (não negociável)

| Verdade | Dono | O outro lado faz |
|---|---|---|
| Placar e fases do PK | **Game Server** | API grava o resultado apurado |
| Saldo, preço, inventário | **API + Postgres** | Game server pede a cobrança e obedece |
| Identidade do jogador | **Token assinado pela API** | Game server confere assinatura |
| Aparência do avatar | **API** (validada contra o inventário) | Viaja assinada dentro do token |
| Dono/decoração/privacidade do apartamento | **API** | Sala recebe só o `apartmentId` |
| Posição e colisão | **Game Server** | Cliente prevê com a mesma função |

O que o navegador PODE dizer: seu token, para onde quer andar, o que quer
falar, qual presente quer mandar, e o título da própria live. Só isso. Se você
está prestes a aceitar um `hostId`, `ownerId`, `avatar` ou `visibility` vindo do
cliente, pare: já tivemos essa falha e ela custou uma rodada de correções.

Um convite de palco é convite de verdade: host manda `invite`, o convidado
manda `acceptStage`, e o servidor confere que o convite é dele e não expirou.
Não existe "pedir para ser co-host" no join.

## Como rodar a API

```
cd packages/api
npm run migrate && npm run seed     # Postgres de dev já roda em :55432
npm run dev                          # :8787
```

O seed cria ana/beto/caio/moderador (senha `streampolis-dev`).
`POST /auth/dev-login {"username":"ana"}` devolve o token de sessão — é ele que
vai no `?token=` do cliente e no join das salas.

Para rodar o game server contra a API de verdade:

```
AUTH_JWT_SECRET=dev-only-access-secret-change-me \
API_BASE_URL=http://127.0.0.1:8787 \
API_SERVICE_TOKEN=dev-only-service-token \
npm run dev --workspace @streampolis/game-server
```

Sem `API_BASE_URL` o game server usa stubs em memória e AVISA no log — bom para
desenvolver, proibido em produção (o próprio código recusa subir assim lá).
`npm run e2e:api --workspace @streampolis/game-server` prova a integração
inteira: token assinado, débito real na carteira, PK gravado no banco.

## Onde a colisão mora

Em `packages/shared/src/collision.ts`, e só ali. O servidor decide onde dá para
pisar e o cliente prevê com a MESMA tabela; se alguém escrever um segundo
solver, o jogador atravessa a fonte de um lado e bate nela do outro. As
posições dos props vêm de `packages/shared/src/layout.ts` pelo mesmo motivo: a
cena desenha a partir da tabela de onde os colliders são gerados.

## Cenas: qual arquivo desenha qual mundo

`packages/client/src/game/scenes/index.ts` é o registro. `createScene(sceneId)`
devolve a cena daquele id e a tabela é exaustiva por tipo — um `SceneId` novo
sem cena quebra o build em vez de cair na praça calada.

- A praça (`PlazaScene`) é autoral: geometria escrita à mão a partir de `PLAZA`.
- Todo interior é `InteriorScene`, dirigida por dados: casco + fixtures +
  iluminação vêm de `packages/shared/src/interiors.ts`, e cada sala
  (`ApartmentScene`, `LiveRoomScene`, `PkArenaScene`, `PublicScenes`) só escolhe
  seu grade, sua luz, suas superfícies e o `dress()` que lhe é próprio.

O layout dos interiores mora no pacote shared pelo mesmo motivo que `PLAZA`:
`collision.ts` gera dali os colliders, a área caminhável e os **spawns** — que o
servidor lê em `world/Spawns.ts`. Mover um sofá move o collider do sofá.

O mundo só constrói a cena DEPOIS de entrar na sala: quem manda no cômodo é o
servidor, não a query string.

## Animação: do estado na rede ao corpo na tela

`state.anim` viajar não é o avatar se mexer. O caminho completo:

```
Clips.ts     poses autorais (graus, DELTAS do rest, corpo olhando +Z)
Compile.ts   ClipSpec -> AnimationClip: ground lock, foot lock, medição
Library.ts   compila uma vez por balde de rig e compartilha
Animator.ts  máquina de estados por avatar: crossfade, one-shots, rate
World.ts     mede a velocidade DESENHADA e chama setAnim/animate por ator
```

Duas armadilhas já pagas, não as reintroduza:

- clipe de locomoção usa `ease: 'linear'` e `locomotion: true`. Com easing o pé
  plantado desliza; o compilador mede isso (`maxSlide`) e corrige pelo quadril.
- `--anim=` no shoot fixa o estado (`Animator.pin`), porque pedir `walk` a um
  corpo parado devolve `idle` — correto no jogo, inútil para fotografar.

`node tools/shoot.mjs ... --anim=dance` grava no `.json` irmão o relatório de
todos os clipes: velocidade autoral, deslizamento do pé e folga do solo. Walk
abaixo de 2 cm de deslizamento é o alvo.

## Como rodar e como VER o resultado

O servidor de dev já está no ar em `http://127.0.0.1:5273` (Vite, com HMR —
não precisa reiniciar). Se tiver caído:
`npm run dev --workspace @streampolis/client &`

Captura headless (SwiftShader; use resoluções modestas, cada frame é lento):

```
spshot --url='http://127.0.0.1:5273/?...' --out=shots/nome.png --w=700 --h=900 --settle=1200
```

Bandeiras úteis: `--scene=` na URL (`?view=world&scene=live_room`), `--anim=`
para fixar uma pose e `--mode=canvas` para capturar pelo próprio renderer
(`Renderer.capture()`: um render e um `toDataURL` na mesma tarefa). O contexto
NÃO usa `preserveDrawingBuffer` — ele custa uma cópia de tela por frame no
gameplay inteiro para servir a um screenshot ocasional.

Isso grava `shots/nome.png` e um `.json` irmão com `renderer.info` e os erros de
console. **Sempre leia o PNG com a ferramenta Read depois de capturar.** Um
build que compila não é evidência de que está bonito; olhe a imagem.

Para conferir o multiplayer de verdade: `node tools/mp-check.mjs` sobe uma
página real como Ana e um segundo jogador headless via colyseus.js, e imprime
quantos avatares o cliente desenhou. Duas páginas 3D ao mesmo tempo no
SwiftShader se matam de fome e estouram a reserva de assento — por isso o
segundo jogador não renderiza.

`node tools/probe.mjs '<url>' <fn>` chama `window.__lab.<fn>()` e imprime o JSON
— use para inspecionar posições de bone, bounding boxes etc. em vez de adivinhar.

Antes de terminar: `npx tsc --noEmit -p packages/client/tsconfig.json` limpo.

## Regras de arquitetura (SPECs §68 — não negociáveis)

1. Three.js renderiza. Não decide economia.
2. Colyseus sincroniza mundo e eventos. Não substitui o banco.
3. PostgreSQL é a fonte de verdade dos dados permanentes.
4. O Wallet Ledger é a fonte de verdade da economia.
5. Redis guarda estado rápido, nunca patrimônio.
6. O cliente **nunca** é autoridade sobre dinheiro, inventário ou PK.
7. A Live Room tem que ser bem mais leve que a City Room.
8. Nada no núcleo pode depender de streaming de vídeo.

## Barra de qualidade visual

Alvo: simulador de vida estilizado semi-cartoon (SPECs §4), 60 FPS no desktop e
30 FPS estáveis em aparelhos modestos (§5). Concretamente:

- Silhueta legível a 30 px de altura. Se o personagem vira uma mancha, falhou.
- Nada de faceta visível em superfície que deveria ser curva.
- Nada de "tampa" plana aparecendo (o loft fecha com taper, não com disco).
- Materiais com variação: rugosidade e normal map, nunca cor chapada.
- Sombras de contato presentes; um objeto que não ancora no chão flutua.
- Nada estourado: se o histograma satura em branco, a exposição está errada.

## Convenções de código

- TypeScript estrito. Sem `any` solto, sem `@ts-ignore`.
- Comentário só onde o *porquê* não é óbvio — nunca reescrevendo o que o código
  já diz. Prefira explicar a armadilha que a linha evita.
- Texto de UI em pt-BR. Identificadores em inglês.
- Nada de asset externo baixado: tudo procedural (SPECs §44 dá 20 MB de budget
  para o first play inteiro).
- Reaproveite `game/materials/Textures.ts` e `Noise.ts`; não escreva um segundo
  gerador de ruído.
- Objetos repetidos usam `THREE.InstancedMesh` (SPECs §7).
- Materiais compartilhados sempre que possível; acompanhe `renderer.info.calls`.

## Propriedade de arquivos

Você trabalha em paralelo com outros agentes. **Só edite os arquivos listados na
sua tarefa.** Se precisar de algo fora do seu escopo, defina a interface no seu
lado e deixe um TODO nomeando o dono — não edite o arquivo alheio.
