# Rubrica de revisão visual — Streampolis

Este documento é o padrão contra o qual cada captura é julgada. Ele existe
porque a comparação lado a lado originalmente pedida é impossível: o
repositório de referência contém apenas o PRD e as SPECs, não um jogo. O
substituto é este: um crítico avalia a imagem contra critérios objetivos,
**sem saber qual iteração está vendo**, e a nota é a menor nota de qualquer
eixo — não a média. Um único eixo reprovado reprova a captura.

O alvo declarado nas SPECs §4 é **3D estilizado semi-cartoon**, não realismo
fotográfico. "Qualidade AAA" aqui significa execução impecável dentro desse
estilo, não fotorrealismo: um jogo estilizado bem feito e um jogo realista mal
feito não competem na mesma escala.

## Como pontuar

Cada eixo recebe 0 a 5.

- **0** quebrado — artefato que qualquer pessoa nota em 1 segundo.
- **1** amador — parece um protótipo de tutorial.
- **2** funcional — comunica, mas ninguém pagaria por isso.
- **3** competente — indie sólido, nada memorável.
- **4** comercial — sustenta uma captura de tela de loja.
- **5** referência — sustenta um trailer.

**Aprovação exige 4 em TODOS os eixos aplicáveis.** Abaixo disso, o crítico
escreve o defeito específico e a captura volta para o ciclo.

## Eixos

### 1. Silhueta
Reduza a imagem para 60 px de altura mentalmente. Formas ainda são
identificáveis e distintas entre si? Personagens diferentes continuam
distinguíveis? Silhueta é o que o jogador lê primeiro e o último recurso que
sobra a distância.
Reprova: contornos que viram mancha; dois personagens com a mesma forma.

### 2. Forma e proporção
Escala humana correta e consistente (o avatar tem 1,67 m; porta 2,1 m; assento
de banco 0,45 m; balcão 0,9 m). Anatomia coerente no estilo escolhido.
Reprova: membro que sai do lugar errado; objeto fora de escala; corpo que
mede certo mas lê como manequim de arame.

### 3. Superfície e material
Toda superfície tem variação de rugosidade e relevo. Metal parece metal;
tecido parece tecido. Nada de cor chapada.
Reprova: plástico genérico em tudo; textura esticada ou repetindo visivelmente
(tiling óbvio); normal map estourado que vira relevo de plástico.

### 4. Iluminação
Direção de luz clara, com luz principal, preenchimento e separação do fundo.
Sombra de contato presente onde os objetos tocam o chão.
Reprova: qualquer coisa flutuando sem sombra; cena iluminada apenas por
ambiente, sem direção; sombra dura e serrilhada.

### 5. Exposição e cor
Histograma sem saturar em branco nem empastar em preto. Paleta com intenção.
Reprova: céu estourado que engole o horizonte; personagem que perde detalhe
por superexposição; sujeira de cor sem propósito.

### 6. Composição e câmera
Enquadramento com intenção, linha do horizonte deliberada, distância focal
que não distorce rostos.
Reprova: cabeça cortada por acidente; sujeito centralizado sem motivo com
metade do quadro vazio; grande angular deformando o personagem.

### 7. Limpeza técnica
Sem serrilhado bruto, sem z-fighting, sem geometria invertida, sem costura
visível entre partes, sem facetamento em superfície curva, sem "tampa" plana
de loft aparecendo.
Reprova: qualquer um dos anteriores.

### 8. Densidade e leitura
Detalhe suficiente para o olho ter onde pousar, sem virar ruído. Hierarquia:
o assunto principal ganha o contraste.
Reprova: cena vazia com chão infinito; ou entulho uniforme sem foco.

### 9. Orçamento (não é estética, mas reprova igual)
Confira o `.json` que acompanha a captura. Metas das SPECs §5-§7:
- 60 FPS no desktop, 30 FPS estáveis em aparelho modesto.
- Praça inteira: até ~180 draw calls no preset `high`.
- Avatar vestido: até ~14k triângulos e no máximo 6 draw calls.
- Nenhum erro no console (o campo `errors` tem que estar vazio).
Reprova: erro de console; orçamento estourado sem justificativa escrita.

### 10. Interface (quando a captura tiver UI)
Hierarquia tipográfica, espaçamento consistente, contraste acessível, estados
de hover/active/disabled desenhados, área de toque de 44 px no mobile.
Reprova: texto sobre imagem sem contraste; emoji usado como ícone; densidade
de formulário.

## Vieses que o crítico deve resistir

- **Novidade não é qualidade.** "Mudou desde a última vez" não é motivo para
  subir a nota.
- **Esforço não é qualidade.** Um sistema procedural complexo que produz uma
  imagem feia é uma imagem feia.
- **Elogiar o que está certo não compensa o que está errado.** A nota é o
  mínimo dos eixos, não a média.
- **A ausência de defeito não é presença de qualidade.** Uma cena vazia e
  limpa não passa de 3.
