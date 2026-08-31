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

## Onde a colisão mora

Em `packages/shared/src/collision.ts`, e só ali. O servidor decide onde dá para
pisar e o cliente prevê com a MESMA tabela; se alguém escrever um segundo
solver, o jogador atravessa a fonte de um lado e bate nela do outro. As
posições dos props vêm de `packages/shared/src/layout.ts` pelo mesmo motivo: a
cena desenha a partir da tabela de onde os colliders são gerados.

## Como rodar e como VER o resultado

O servidor de dev já está no ar em `http://127.0.0.1:5273` (Vite, com HMR —
não precisa reiniciar). Se tiver caído:
`npm run dev --workspace @streampolis/client &`

Captura headless (SwiftShader; use resoluções modestas, cada frame é lento):

```
spshot --url='http://127.0.0.1:5273/?...' --out=shots/nome.png --w=700 --h=900 --settle=1200
```

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
