# Streampolis — Visual Target v1

Este documento é o **norte visual** do projeto. A rubrica (`VISUAL_RUBRIC.md`)
diz como julgar uma captura; este diz **onde queremos chegar**.

A versão navegável, com o alvo lado a lado com o que o jogo desenha hoje, está
em <https://streampolis.nutef.com/visual-target/> — a fonte dela é
`packages/client/public/visual-target/`.

## A frase

> **Legibilidade de personagem de simulador de vida + limpeza estilizada de
> jogo competitivo moderno + linguagem de interface de live.**

Sem realismo. O que o produto precisa é **charme**: um avatar que a pessoa
queira vestir, uma casa que ela queira mobiliar, uma live que ela queira abrir.
Cada uma dessas vontades é uma linha de receita — o visual aqui não é enfeite,
é o motor da monetização (PRD §13, §16).

## Como usar as imagens de referência

As imagens em `public/visual-target/*.jpg` que **não** começam com `hoje-` são
arte conceitual. Elas valem por **intenção**: proporção, paleta, material,
clima. Não são especificação de geometria, e duas ressalvas são explícitas:

- qualquer texto que apareça nelas é ruído do gerador, não um letreiro a copiar;
- a praça do conceito é mais realista do que queremos — copie a **leitura**
  (cor, densidade, vida), não o render.

As imagens `hoje-*` são capturas reais do build. Elas envelhecem: quando uma
delas alcançar o alvo, troque a captura e escreva aqui o que mudou.

## O alvo, por área

### Personagem — quatro entregas feitas
O avatar é o produto que o jogador compra roupa para vestir. O que o alvo
pedia, e onde está:

- ~~**Feições como geometria**~~ — nariz, boca, sobrancelha e orelha modelados
  (`Face.ts`). Nariz e orelha entram fundidos na geometria da cabeça: nenhum
  draw call a mais e nenhuma chance de descolar do crânio.
- ~~**Olhos** com íris, pupila, brilho e cílio~~ — todos como calota esférica
  sobre o globo, não como disco chapado.
- ~~**Quatro expressões**~~ — neutro, sorriso, surpresa e foco, interpoladas a
  12 Hz. `setAnim` já as escolhe: dançar sorri, presente surpreende, perder um
  PK concentra.
- ~~**Mãos com cinco dedos**~~ — palma, quatro dedos e polegar. Todos pesam no
  osso `Hand`: o rig não tem juntas de dedo e inventá-las obrigaria a
  retargetar todo clipe. O que se compra é silhueta.
- ~~**Cabelo em mechas**~~ — `Hair.ts`, nove estilos sobre base + mechas +
  franja + laterais + volume traseiro. Tudo funde numa geometria só, então um
  estilo com trinta mechas ainda custa um draw call.

O que falta no personagem: dedos articulados (exige ossos novos), cabelo que
reage ao movimento, e roupa com corte de verdade — gola, punho, caimento.

**Os três defeitos de geometria estão corrigidos** (Sprint Avatar A) e agora
são medidos, não julgados:

1. ~~os dois calçados se fundem num bloco único~~ — a folga mínima medida na
   matriz é de 62 mm;
2. ~~a pele aparece em manchas na cintura~~ — nenhum raio encontra pele fora
   da roupa em 120 combinações;
3. ~~as pernas não têm vão entre si~~ — o vão mínimo abaixo do joelho é de
   36 mm.

O que os resolveu, e vale para toda peça futura:

- **roupa é o corpo inflado.** Toda banda de tecido é amostrada do próprio
  perfil do corpo (`torso()`, `arm()`, `leg()`) e não de uma segunda tabela de
  raios. Dois perfis independentes era o que punha a bunda para fora da
  camisa: o corpo recua em Z no glúteo e a roupa não recuava junto.
- **contrato de cintura.** Toda blusa desce até `HEM_MAX` e todo cós sobe até
  `WAIST_MIN` (`Wardrobe.ts`), com ~10 cm de sobreposição. Nenhuma combinação
  pode abrir uma faixa de pele; um cropped deliberado terá de mudar a
  constante e o portão junto, de propósito.
- **folga imposta por construção.** `legInnerLimit()` define quanto uma perna
  pode chegar do plano médio — zero na virilha, `LEG_GAP/2` do joelho para
  baixo — e corpo E roupa se cortam contra ela. Uma calça larga não fecha o
  vão que o corpo acabou de abrir.
- **massa não compõe com membro.** `limbs * mass` dava ao preset pesado um
  joelho mais largo que a própria cabeça; agora a massa entra pela metade.

### O portão

`npm run gate:avatar` renderiza e **mede** 120 combinações (4 corpos × 3
blusas × 3 calças × 3 sapatos, mais uma varredura das peças restantes),
escreve `shots/matrix/report.json` e uma folha de contato, e sai com código
não-zero se qualquer combinação quebrar. Ele mede por raio contra a superfície
real, não por opinião:

| Medida | Mínimo | Pior valor hoje |
|---|---|---|
| Folga entre calçados | 22 mm | 62 mm |
| Vão entre as pernas abaixo do joelho | 18 mm | 36 mm |
| Pele fora da roupa | 0 raios | 0 raios |

**Nenhuma roupa nova entra no guarda-roupa com esse portão vermelho.** Uma
peça herda o corpo de onde é lofted; cem peças sobre um corpo quebrado são cem
peças quebradas.

O que já está certo e não deve ser mexido: proporção (1,67 m), presets de corpo
que mudam silhueta de verdade, e o pipeline de vestir — que valida posse antes
de deixar usar (SPECs §68).

### Praça Central — falta cor e vida
Composição, iluminação e mobiliário urbano já existem. O alvo acrescenta:

- **paleta quente** (laranja, terracota, verde saturado) no lugar do cinza-pedra;
- **vegetação variada** — palmeira, arbusto florido, canteiro;
- **NPCs decorativos** circulando. O `QualityManager` já reserva orçamento para
  eles (`ambientNpcs`), e ninguém os desenha ainda.

### Apartamento — falta variedade
A planta e a luz da janela já entregam o clima. Falta catálogo: sofá em mais de
um formato, cama, tapete, quadro, bugiganga de mesa. É o mesmo trabalho que a
loja vai cobrar.

### Live Room — é a área mais próxima do alvo
Painel de LED como fonte de luz, marca no chão, ring light, feixes visíveis e
recorte do host contra o fundo já funcionam. Manter.

### Interface — já chegou
Vidro, informação nas bordas, o 3D respirando no meio, capa do feed renderizada
pelo próprio jogo. Não há coluna "alvo" para a UI porque ela é o alvo.

## Regras não negociáveis

| Regra | O que significa |
|---|---|
| **Proporção** | Avatar 1,67 m, cabeça ~7,5% maior que o real. Porta 2,1 m, assento 0,45 m, balcão 0,9 m. |
| **Silhueta** | A 60 px de altura, dois personagens têm de continuar distinguíveis. |
| **Material** | Nada de cor chapada: toda superfície tem rugosidade e relevo próprios. |
| **Luz** | Chave + preenchimento + recorte, e sombra de contato sempre. |
| **Cor** | Ambiente contido; saturação alta reservada ao que é interativo (LED, neon, presente, PK). |
| **Exposição** | Sem estourar no branco nem empastar no preto. Live escura é escolha, não engano. |

### Paleta

| Cor | Uso |
|---|---|
| `#ff2d6f` | Ao vivo. Nada mais. |
| `#7c5cff` | Marca, ação primária |
| `#4fd8ff` | Credits, informação |
| `#ffc247` | Coins, prestígio |
| `#39d98a` | Confirmação, posse |
| `#c9c1b4` | Pedra da praça |
| `#a9714b` | Madeira de interior |
| `#11141f` | Superfície de UI |

## Ordem de ataque

1. ~~**Costura do corpo**~~ (pé, cintura, vão entre as pernas) — feito, e agora
   defendido pelo portão.
2. ~~**Rosto e mãos.**~~ — feito.
3. ~~**Cabelo em mechas.**~~ — feito, nove estilos.
4. **Roupa com corte** — gola, punho, barra, caimento. É o próximo: hoje toda
   peça é o corpo inflado, o que resolveu a cintura mas não dá corte a nada.
   O ombro da manga ainda é o ponto mais fraco.
5. **Cor e vida na praça.**
6. **Catálogo de móveis.** A loja cria a pressão; o apartamento a transforma em
   permanência.

### Ferramentas de revisão

| Comando | O que responde |
|---|---|
| `npm run gate:avatar` | as 120 combinações estão geometricamente sãs? (portão, sai não-zero) |
| `node tools/face-sheet.mjs` | cada preset de rosto, em cada expressão, em vários giros |
| `node tools/face-sheet.mjs --styles=a,b,c --zoom=1.7` | os estilos de cabelo, de frente, de lado e de costas |
| `node tools/hand-shot.mjs` | a mão de perto, em três vistas |

Duas armadilhas que custaram tempo e valem para qualquer revisão futura:

- **gire o avatar, não a cabeça.** Torcer o pescoço 150° para ver a nuca traz o
  rabo de cavalo para a frente do peito e revisa uma pose que ninguém segura.
- **enquadre o que você está julgando.** Cabelo longo vive quase todo ABAIXO de
  um retrato de cabeça e ombros; num recorte desses ele parece curto e o bug
  está no enquadramento, não na geometria.

## Como as referências foram feitas

Arte conceitual gerada pelo worker de imagem da Cloudflare da própria casa
(`/root/imagem-worker`, modelo `flux-1-schnell`), com os prompts registrados em
`tools/visual-target.py`. Regerar é barato: mude o prompt, rode o script,
recomprima e publique. Duas armadilhas conhecidas do worker: o User-Agent padrão
do `urllib` toma 403 da Cloudflare (mande UA de navegador) e o flux ignora
largura/altura, devolvendo o tamanho nativo dele.
