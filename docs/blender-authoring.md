# Autoria local do movimento V2

A dança social dura quatro segundos, a 30 fps (121 chaves incluindo fechamento).
Foi criada no Blender 4.5.9 LTS pelo Blender MCP local, com telemetria desligada
e socket em `127.0.0.1:9876`. Nada do MCP é instalado na VPS.

O arquivo de autoria contém um rig auxiliar anatômico e quatro alvos IK para
mãos/pés. Ele corrige posições/comprimentos somente nos controles de autoria.
Os 62 bones deformadores, seus parentes e matrizes de repouso permanecem
intactos. Os dedos conservam a pose relaxada do Idle do pacote. Os controles
são amostrados e o resultado recebe bake nos 62 bones de uma cópia do rig.

O asset publicado contém somente nós e animação: sem malhas, skins ou helpers.
As roupas continuam carregando o mesmo esqueleto. Os rigs masculino e feminino
têm bakes separados, em `assets/animations/social_dance_m.glb` e
`social_dance_f.glb`. O carregador usa apenas os clips desses arquivos.

## Reproduzir

Tenha os arquivos originais dos personagens em
`assets/vendor/authoring/m.glb` (Casual Character) e `f.glb` (Animated Woman).
Eles são insumos locais; o catálogo de produção continua intocado.

No Blender MCP local execute o conteúdo de
`tools/assets/blender-social-dance.py` e então `main(caminho_do_repo, 'm')`
e `main(caminho_do_repo, 'f')`. O script salva o trabalho aberto primeiro,
cria cenas próprias, grava `.blend`, samples e referência de deformação.

```sh
node tools/assets/pack-blender-animation.mjs
node tools/assets/verify-blender-animation.mjs
node tools/assets/rig-contract.mjs
npm run test:avatar-motion
npm run gate:wardrobe
```

A conversão usa as **inverse bind matrices**, combinadas com a transformação
do mesh, para recuperar os eixos originais glTF. O TRS inicial de um nó é uma
pose de animação neste pacote: tratá-lo como bind aplica o Idle duas vezes.
Por isso o portão compara também a deformação da malha em cinco tempos entre
Blender e Three.js, além de verificar nomes, duração, fechamento e valores.
As medidas dos pés pertencem aos controles dos pés, não são uma promessa
de ausência absoluta de qualquer penetração da superfície dos sapatos.

## O que permanece para a próxima autoria

Os 83 GLBs originais e os slots foram congelados por hash em
`assets/rig-contract.json`; os pesos atuais passaram na normalização. Não foi
feita uma repintura arbitrária nem uma alteração do bind para melhorar uma
pose isolada. Correções de peso e anatomia devem ser variantes revisadas contra
o contrato, com imagens de todas as peças afetadas.

`FacialMorphs` admite cabeças explicitamente marcadas com morphs reais
`smile`, `sad`, `surprise` e `mouthOpen`, com proprietário único dos pesos
(expressões ou AnimationMixer). Sem esses assets o rosto atual é preservado.
Nariz, boca integrada, novos lábios, olhos e cabelos ainda precisam de autoria
visual; não foram substituídos por deformações automáticas genéricas.

LOD está preparado e validado por manifesto, mas não ativado. Os dois conjuntos
medidos nesta revisão têm 5.776 e 6.424 triângulos antes de overlays faciais;
13k/7k/3k não são contagens universais do catálogo. A redução de roupas e prédios
deve partir da medição de cada modelo, preservando cabeça/forro e costuras.
Checkout e admin não foram alterados nesta entrega de movimento e escala.
