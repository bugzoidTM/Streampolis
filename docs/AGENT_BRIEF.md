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

## No ar

<https://streampolis.nutef.com> — demonstração pública: entra-se por
personagem, sem cadastro. O desenho da stack (um domínio, três caminhos), os
segredos, o passo a passo de atualizar e o porquê da porta aberta estão em
`deploy/README.md`. O norte visual, com alvo e realidade lado a lado, está em
<https://streampolis.nutef.com/visual-target/> e em `docs/VISUAL_TARGET.md`.

`node tools/prod-check.mjs` é a fumaça da produção: primeira visita, escolher
personagem, entrar no mundo e conferir que a sala é de verdade.

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

## Quem entra na sala (e por quê o World não decide isso)

```
URL / UI  →  WorldIntent  →  NetworkClient  →  WorldConnection
                                                    ↓
                                       World(connection) desenha
                                       a cena que o ESTADO diz
```

`network/session.ts` traduz a intenção em sala: `joinCity`, `joinApartment`,
`goLive` ou `watchLive`. O `World` recebe a conexão pronta e pergunta a ela em
que cena está — ele não abre sala nenhuma. Antes ele chamava sempre
`joinCity(sceneId)`, e como a CityRoom só aceita cenários públicos, um
`scene=live_room` virava praça: a cena de live existia, a LiveRoom existia, e o
jogador acabava no lugar errado sem nenhum erro na tela.

Pela URL: `?watch=<roomId>` assiste, `?golive=1&title=` transmite,
`?apartment=me` abre a própria casa (a API responde qual é), `?scene=` escolhe
área pública. Sem `?token=` tudo isso é ignorado e o mundo roda offline.

Uma armadilha já paga: `join()` devolve a sala ANTES do primeiro patch, e nesse
instante `room.state` ainda tem os DEFAULTS do schema — perguntar a cena ali
responde "central_plaza" dentro de uma live. Por isso o `NetworkClient` espera
`connection.ready` antes de entregar a conexão.

## Presentes que aparecem

`game/fx/GiftEffects.ts` transforma o `GiftEvent` em imagem. O efeito nasce
DEPOIS da cobrança — o evento só chega quando a API debitou (§68 regra 4) — e o
replay nunca chega, porque o servidor o descarta. Três níveis pelo preço:
pétalas (até 20 coins), explosão com flash (99 a 2.000) e o foguete (9.999), que
atravessa o quadro, explode e sacode a câmera.

A integração das partículas é feita no vertex shader a partir da velocidade
inicial: 500 partículas não custam 500 objetos atualizados por frame. Dois
detalhes que já custaram uma rodada: o tamanho do sprite é em METROS e depende
de `altura_do_canvas / (2·tan(fov/2))` — uma constante mágica ali vira um disco
de 900 px —, e o foguete entra a poucos graus do eixo da câmera, porque perto e
bem para o lado significa fora do campo de visão.

`node tools/giftshot.mjs --gift=g_rocket --q=10 --delay=2500` fotografa um
efeito sem economia nenhuma (`window.__lab.gift`).

## A tela da live

`ui/LiveView.tsx` é a experiência: selo AO VIVO, host, espectadores, curtidas,
chat rolando, bandeja de presentes e a barra de PK. Ela lê o estado da sala
(`useLiveStore.room`, alimentado por `network/bridge.ts`) e escreve por
intenção: `connection.gift(...)`, `connection.like()`, `connection.chat(...)`.
Nada de saldo, placar ou contagem calculada no cliente.

`node tools/live-check.mjs` prova o caminho inteiro num navegador de verdade:
Ana abre a live, Beto entra headless, fala e presenteia, e o script confere que
a cena é a Live Room, que o presente virou partículas e que a UI está montada.

## As telas de produto

`ui/AppShell.tsx` é a casca: mundo 3D embaixo, telas por cima, navegação no
rodapé (Mundo · Lives · **Go Live** · Loja · Perfil). A decisão que organiza
tudo é esta: **o mundo nunca desmonta ao trocar de aba** — ele PAUSA
(`World.setPaused`). O que remonta o mundo é mudar de intenção, e por isso a
navegação tem duas naturezas:

- `setTab` é interface (abrir a loja, ver o perfil);
- `navigate(intent)` é viagem (entrar numa live, visitar um apartamento), e a
  chave de remontagem do `WorldView` muda junto.

As três telas leem do servidor e escrevem por intenção:

| Tela | Lê | Escreve |
|---|---|---|
| `FeedView` | `GET /lives` + contagem ao vivo do game server | nada |
| `ProfileView` | `GET /users/:id` (ou `/me`) | `PUT /users/:id/follow` |
| `StoreView` | catálogo do shared + `/me` (carteira, inventário) | `POST /me/purchases`, `PUT /me/avatar` |

Nenhuma delas subtrai carteira, soma seguidor ou decide preço. O preço mora no
banco (`packages/api/src/shop/Purchases.ts`) e a entrega do item acontece na
MESMA transação do débito — moeda saindo sem item entrando é o defeito que vira
suporte.

`node tools/screens-check.mjs` prova as três num navegador de verdade: Beto
abre uma live headless, Ana navega Feed → Perfil → Loja, compra uma peça e a
carteira do servidor muda. Precisa dos três processos no ar (API, game server
apontado para ela, Vite).

## Retratos 3D na UI

`game/portrait/PosterStudio.ts` mantém um segundo contexto WebGL, minúsculo, e
devolve um PNG de um avatar. É o que faz o card do feed mostrar o host de
verdade e a loja mostrar a peça VESTIDA em quem está olhando — o argumento de
venda inteiro em uma imagem, e a vantagem sobre um feed de vídeo.

Três coisas o mantêm barato: cache por (aparência + enquadramento + pose), fila
serial (montar dois avatares ao mesmo tempo trava a thread) e descarte do avatar
logo após o clique do obturador.

O enquadramento é trigonometria, não tentativa: com fov de 30° a altura visível
é `2·d·tan(15°) ≈ 0,54·d`. Corpo inteiro pede ~2 m de altura visível, busto pede
~0,8 m. Chutar a distância foi o que decapitou o primeiro lote de retratos.

## Feed de lives: quem responde o quê

`GET /lives` (API) é a LISTA — quem está no ar é estado persistente e social, e
sobrevive a um game server reiniciando. A contagem de espectadores AGORA é
tempo real e vem do `/live` do game server; o cliente junta os dois por
`roomId`. Se o game server não responder, a lista continua certa e o contador
aparece zerado: melhor um número faltando que uma live faltando.

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

## Limites e token (o que já está ligado)

A API tem limitador de taxa por IP em quatro classes: `auth` (baixo — é onde se
testa senha em massa), `economy` (carteira e extrato do jogador), `service`
(`/internal/*`, teto alto porque é um chamador só e cada presente passa por
ali) e `general` para o resto. Rodar um script contra `/auth` várias vezes por
minuto tranca o próprio IP por uma janela; em desenvolvimento o teto é mais
folgado exatamente por isso.

Atrás de proxy, ligue `API_TRUST_PROXY=1` — sem isso todo mundo compartilha o
IP do proxy e o teto vira global.

A API também responde CORS (`src/http/middleware/cors.ts`). Em produção
`API_CORS_ORIGINS` é obrigatória: curinga numa API que move dinheiro é convite.
Fora de produção ela libera a origem que chamar — sem isso o cliente do Vite
recebe tela vazia com 200 no log do servidor, que é o sintoma mais enganoso que
existe.

O game server exige do token, além da assinatura HS256: `iss` igual ao emissor
configurado e `exp` PRESENTE. Um token sem validade é uma credencial eterna, e
o mesmo segredo pode assinar outras coisas que não são sessão.

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
