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
  game/avatar/v2/         corpo de pacote (Kit, AvatarV2) — ver "Corpo do avatar"
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
npm run e2e:shard --workspace @streampolis/game-server  # prova do sharding (§17)
```

O `e2e:shard` baixa a lotação da praça para 2 (`CITY_CAPACITY`) e põe 5
jogadores para entrar: com a capacidade de produção o limite nunca é alcançado,
então o comportamento de shard não apareceria em teste nenhum.

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
| Qual CORPO desenha o avatar | **API** (`body` validado contra posse) | Cliente cai para `v1` se duvidar |
| Quem está em qual sala AGORA | **Game Server** (tem o socket) | API junta os retratos e responde |

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

## Presença: quem está em qual shard

Com a praça shardada, "está na praça" deixou de ser endereço — são várias
praças centrais ao mesmo tempo. O diretório de presença responde
`userId → sceneId → roomId`, e mora em dois pedaços:

- **game server** (`world/Presence.ts`) acumula quem está em sala NESTE processo
  e publica em `POST /internal/presence` o retrato **inteiro** do processo, a
  cada mudança (janela de 150 ms) e a cada 15 s de batimento;
- **API** (`social/PresenceDirectory.ts`) junta os retratos em memória e expira
  a fatia de quem parou de falar (`PRESENCE_TTL_MS`, 45 s).

Retrato inteiro em vez de delta é a escolha central: uma mensagem perdida se
conserta sozinha na seguinte, sem fila de reenvio e sem fantasma eterno. Nada
disso vai para o Postgres — se o game server cai, ninguém está em sala nenhuma,
e uma linha no banco dizendo o contrário seria uma mentira durável.

Duas leituras, dois públicos: **estado** (`in_world`, `streaming`) é grosso e
sai no perfil de qualquer um; **shard** (`roomId`) é endereço e só sai em
`GET /me/presence` — quem tem o roomId chega na pessoa.

## Câmera e mouse: o jogo é de computador

A câmera é uma órbita de terceira pessoa (`game/CameraManager.ts`) e quem a
alimenta é o `InputManager`. No computador:

- **arrastar orbita** — com o botão esquerdo OU o direito. Só o direito era um
  atalho que ninguém descobre, e a impressão que sobrava era a de um jogo que
  se move em quatro direções;
- **a roda aproxima**, e o passo é MULTIPLICATIVO (`ZOOM_POR_CLIQUE`): o braço
  vai de 1,4 m a 9 m, e uma quantidade fixa em metros por clique é grosseira
  num extremo e imperceptível no outro;
- o `deltaY` da roda é normalizado em CLIQUES antes de sair do `InputManager`
  (Chrome manda ≈100 por clique, Firefox manda linhas). Somar o número cru faz
  o zoom ter velocidades diferentes por navegador;
- `input.orbitOnDrag = false` entrega o botão esquerdo a quem precisa dele. O
  modo de construção faz isso enquanto está aberto — lá o arrasto esquerdo
  arrasta MÓVEL — e o direito continua orbitando.

Uma armadilha já paga: o `World` multiplicava a roda por `0,01` antes de passar
à câmera, o que dava **quatro milímetros por clique**. O zoom existia, respondia
e não movia nada que o olho pudesse notar.

`node tools/desktop-check.mjs` prova as três coisas com o ponteiro de verdade.

## Gestos e quem está aqui: o mundo como lugar com gente

Duas metades do "encontrar jogadores" do PRD §6, ambas ligadas depois de o
multiplayer já sincronizar corpos:

- **`ui/EmoteBar.tsx`** manda `connection.emote(anim)`, teclas **1..6**. O
  servidor já aceitava os seis gestos (`EMOTABLE` em `BaseWorldRoom`), com
  recarga de 900 ms e recusa para quem está andando, desde sempre — faltava só
  um caminho da mão do jogador até lá, e sem ele um mundo multiplayer tinha
  exatamente uma forma de se expressar: texto. O gesto vai como INTENÇÃO e
  volta como estado: quem gesticula vê a mesma animação que os outros veem,
  pelo mesmo caminho. Tocar localmente "para não esperar" é como se cria um
  jogador que dança sozinho na própria tela.
- **`ui/RosterPanel.tsx`** lista quem está na sala e cada linha abre o perfil.
  A fonte é `state/useRoomStore.ts`, alimentada pelo `bridge` — e a regra ali é
  a FREQUÊNCIA: o estado chega a ~20 Hz e é quase todo posição, então a store só
  é reescrita quando a COMPOSIÇÃO muda (uma assinatura de nomes, papéis e
  níveis). Sem isso o painel redesenharia vinte vezes por segundo para mostrar
  os mesmos nomes.

Ícone de UI é DESENHADO (`ui/Icons.tsx`), nunca emoji — a primeira versão da
barra de gestos usou emoji e saiu com seis quadradinhos vazios na captura de
prova, porque o Chromium headless não tem a fonte.

`node tools/social-check.mjs` prova as duas direções da rede: Ana gesticula e a
prova é lida no estado que o BETO recebe; Beto gesticula e a prova é lida no
corpo que a ANA desenha. Um gesto que só o próprio jogador vê é o defeito
clássico desta feature.

`AvatarLike.anim` existe por causa dessa prova: `World.stats().anim` perguntava
ao `Animator`, que só o corpo procedural tem, e respondia `'idle'` para todo
mundo desde a migração v2 — com o avatar dançando na tela.

## Portas e onde se nasce

Duas tabelas em `packages/shared`: `portals.ts` (onde estão as portas) e os
`spawns` de cada interior em `interiors.ts`. Elas têm de ser lidas JUNTAS, e a
regra é uma só: **ninguém nasce dentro de uma porta**.

Já nasceu. Três de quatro interiores punham o ponto de chegada dentro do raio
da própria saída, e a saída de um interior é deduzida do casco: a profundidade
vinha do `shell` e o X era chutado como 0 — no apartamento, cuja porta está em
`x = -2,2`, o arco ficava dois metros ao lado dela, no meio do quarto, com raio
de 2,2 m. Entrar na própria casa abria com "Sair" na tela; no saguão, cuja
saída dá na PRAÇA, quem subia para buscar a própria casa reaparecia na praça.

Hoje: a porta é a abertura sul que chega ao chão (`y === 0`), o raio de
interior é 1,4 m, e `packages/game-server/test/world.test.ts` recusa qualquer
planta em que uma chegada caia dentro de uma porta, fique rente à borda dela ou
nasça dentro de um móvel. Mover um sofá ou uma porta roda contra esse teste.

O marcador desenhado também é escalado pelo raio da porta e pelo pé-direito da
sala (`game/Portals.ts`): com tamanho fixo, o anel da praça virava um disco
rosa de quase três metros dentro de um estúdio e o pilar de luz atravessava o
teto.

## `me` não é um id

`?apartment=me` e a porta do saguão dizem "a minha casa". Quem traduz isso para
o id de verdade é `resolveApartment`, em `network/session.ts`, UMA vez — e a
resposta fica guardada em `WorldConnection.apartmentId`, exposta como
`World.apartmentId`. A interface pergunta ao mundo, nunca à intenção.

Enquanto a `BuildBar` lia a intenção, ela pedia `/homes/me` à API, levava 404,
engolia o erro e concluía que a casa era de outra pessoa: dentro do próprio
apartamento não havia botão "Decorar" **e a mobília salva pelo jogador não
carregava**.

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
| `RankingsView` | `GET /rankings?board=&range=` | nada |

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

E no card da loja quem manda no quadro é a **peça**, não o tipo dela: com
`focus: <id do item>` o estúdio mede a caixa daquela peça no corpo já posado
(`AvatarV2.pieceBox`) e chega perto o bastante para ela preencher o card. O
`shot` por tipo virou reserva, para quando a medida não é possível. Três
detalhes que a medida precisa ter e que já custaram uma rodada:

- a largura que importa é a **projetada na tela**, não o maior lado da caixa —
  com os pés afastados numa passada, o lado Z de um calçado é profundidade, e
  tratá-lo como largura afasta a câmera até o sapato virar detalhe;
- peça do tronco para cima **ganha o rosto** no quadro (um card de blusa sem
  a pessoa é um quadro de tecido), e quem decide isso é o CENTRO da caixa: pelo
  topo, uma calça começa na cintura e conta como peça de tronco;
- e esse quadro **para na cintura** por baixo, porque a caixa de uma blusa
  desce até o punho: manga caída é braço, e deixá-la mandar recua a câmera.

`npm run gate:cards` prova as 83 peças: cada uma está em cena e enche o próprio
card (contact sheet em `shots/store-cards/`). `window.__lab.poster(config, opts)`
chama o mesmo `renderPoster` da loja sem login nem navegação.

## Placar: por que ele não sai de `player_stats`

`GET /rankings` (PRD §23) soma **eventos datados** — `gift_events` e
`pk_matches` —, nunca os contadores de `player_stats`. Aqueles são vitalícios:
somam desde sempre e não sabem responder "hoje", que é metade da pergunta. Um
placar que só sabe responder "desde sempre" é o monumento a quem chegou
primeiro que a temporada existe para evitar.

Três placares (`streamers` = Creator Points recebidos, `gifters` = Coins
enviados, `pk` = vitórias) e três janelas (`today`, `week`, `season`). "Hoje" e
"semana" são cortes de CALENDÁRIO no fuso do público (`RANKINGS_TIMEZONE`,
default `America/Sao_Paulo`) — em UTC o placar do dia viraria às 21h de
Brasília, no meio do horário de maior audiência. "Temporada" é a linha aberta
em `seasons`; sem nenhuma aberta o placar responde vazio em vez de somar desde
sempre. Board ou range desconhecidos são **400**, nunca um default calado.

Fica de fora o Top Agencies do §23: agência não é requisito do MVP (§30) e um
placar com cinco linhas vazias mente mais do que um placar ausente.

Na tela, o pódio tem rosto e a lista não — não é hierarquia visual, é
orçamento: cada retrato é um render na MESMA fila que serve a loja e o feed, e
vinte de uma vez travam as três.

`node tools/rankings-check.mjs` prova o caminho inteiro: Beto presenteia Ana ao
vivo (gift de verdade, débito real) e o script espera o BANCO mudar antes de
conferir que o placar de hoje mexeu; depois fotografa a tela trocando de placar
e de janela.

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

## Corpo do avatar: v1, v2, e por que a troca não é uma refatoração

Há dois corpos possíveis e **um só lugar onde um corpo nasce**:
`game/avatar/createAvatar.ts`. O `World` não conhece classe de avatar nenhuma;
ele depende de `AvatarLike` — `root`, `eyeHeight`, `setAnim`, `animate`,
`dispose`, e nada mais. Se você está escrevendo `new Avatar(` fora do
laboratório ou do `PosterStudio`, pare: é por aí que a troca vira cirurgia.

- **v1, procedural.** O corpo é gerado, o guarda-roupa é lofteado das estações
  dele e `npm run gate:avatar` mede 176 combinações contra ele. É o corpo do
  jogo.
- **v2, de pacote** (`game/avatar/v2/`). Desenha melhor, traz esqueleto com
  dedos e toca a biblioteca de animação do autor sem retarget — e **não veste
  nada**: as 45 peças são do corpo v1. Por isso ele é um ITEM (`body_v2_01`,
  hoje `active: false`), não um botão de aparência.

O caminho inteiro já existe e é exercitado: `PUT /me/avatar` com `body: 'v2'`
de quem não possui o item responde **403 ITEM_NOT_OWNED**; com o item inativo,
cai para `v1` com o motivo em `rejected`; com o item ativo e possuído, devolve
`body: 'v2'` e a aparência viaja assinada no token como qualquer roupa. O dia
de vender é `active: true` mais o guarda-roupa dele.

Para OLHAR o v2 dentro do jogo: `?body=v2` na URL do cliente. É interruptor de
campo — ele não passa por cima da posse quando o item for para a loja, e o
laboratório continua tendo `?view=lab&v2=1` para a comparação lado a lado.

Duas coisas do v2 que valem para qualquer corpo comprado:

- **O kit carrega uma vez; cada avatar leva um clone** (`SkeletonUtils.clone`,
  não `Object3D.clone` — só ele refaz o vínculo do esqueleto). Geometria,
  material e textura são do KIT: um avatar que sai da cena **não** os descarta,
  ou apaga os outros da tela.
- **O corpo nasce síncrono e chega depois.** O laço que lê o estado da sala não
  pode virar assíncrono porque um corpo agora vem de um arquivo; o construtor
  devolve um nó vazio e adota o kit quando ele chega, guardando a animação
  pedida no meio do caminho.

## Entrar no jogo: duas telas, porque são duas esperas

Tela preta que demora não parece que está carregando; parece que travou. São
duas esperas diferentes e cada uma tem a sua tela:

1. **O bundle** (three.js dentro). A tela de carregamento do jogo é React —
   ela só existe depois que o bundle baixa. Por isso `index.html` traz uma tela
   de arranque **inline**, sem CSS nem fonte externa, que pinta com o primeiro
   byte; `main.tsx` a apaga dois quadros depois do primeiro `render()`.
2. **A cena** (`ui/LoadingScreen.tsx` + `game/assets/loading.ts`). A barra mede
   coisa real: o `LoadingManager` compartilhado por TODO carregador de arquivo
   conta itens carregados sobre pedidos, e as fases (`connect`, `assets`,
   `scene`, `compile`, `ready`) são anunciadas pelo `World`. Barra animada por
   tempo é pior que barra nenhuma.

Regras que já custaram defeito:

- **"Pronto" é o primeiro quadro DESENHADO**, não o fim de `start()` — e são
  quatro (`REVEAL_FRAME`), porque os passes de pós-processamento só compilam
  quando desenham. Anunciar antes devolve o jogador à tela preta.
- **Esses quatro quadros correm mesmo com o mundo pausado.** Trocar de aba
  durante o carregamento pausa o laço; sem essa exceção nada é desenhado,
  ninguém anuncia "pronto" e a tela de carregamento fica para sempre por cima
  da Loja.
- **Carregador novo passa pelo `assetManager`** de `game/assets/loading.ts`.
  Um `new GLTFLoader()` sem ele é um arquivo que a barra não conta e que faz a
  cena aparecer depois dela sumir.
