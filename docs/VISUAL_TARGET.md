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

### Personagem — a maior distância
O avatar é o produto que o jogador compra roupa para vestir, e é onde estamos
mais longe. O alvo pede:

- **Feições como geometria**: nariz, boca, sobrancelha e orelha modelados, não
  pintados. Hoje a cabeça é uma cápsula com duas esferas de olho.
- **Olhos** com íris (anel escuro + brilho pequeno) e cílio como forma sólida.
- **Cabelo em mechas** com espessura, não uma casca sobre o crânio.
- **Mãos com cinco dedos.** O código chama a mão atual de *mitten* — e ela é
  mesmo uma luva.
- **Quatro expressões** no mínimo (neutro, sorriso, surpresa, foco). Uma live é
  um rosto reagindo; sem isso o host é um manequim que dança.

**Antes da beleza, três defeitos de geometria** que aparecem em QUALQUER
combinação de corpo e roupa (verificado renderizando a matriz de presets):

1. os dois calçados se fundem num bloco único;
2. a barra da blusa não encontra o cós da calça e a pele aparece em manchas
   na cintura;
3. as pernas não têm vão entre si, o que mata a silhueta a 60 px.

Nenhum depende de arte nova — são o loft do corpo e o corte das peças. Enquanto
não forem corrigidos, cada roupa nova nasce quebrada.

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

1. **Costura do corpo** (pé, cintura, vão entre as pernas). Correção de
   geometria; sem ela, roupa nova nasce quebrada.
2. **Rosto e mãos.** Destrava avatar, loja, feed e perfil de uma vez só.
3. **Cabelo em mechas.** A peça mais comprada do gênero e hoje a mais fraca.
4. **Roupa com corte** — gola, punho, barra, caimento.
5. **Cor e vida na praça.**
6. **Catálogo de móveis.** A loja cria a pressão; o apartamento a transforma em
   permanência.

## Como as referências foram feitas

Arte conceitual gerada pelo worker de imagem da Cloudflare da própria casa
(`/root/imagem-worker`, modelo `flux-1-schnell`), com os prompts registrados em
`tools/visual-target.py`. Regerar é barato: mude o prompt, rode o script,
recomprima e publique. Duas armadilhas conhecidas do worker: o User-Agent padrão
do `urllib` toma 403 da Cloudflare (mande UA de navegador) e o flux ignora
largura/altura, devolvendo o tamanho nativo dele.
