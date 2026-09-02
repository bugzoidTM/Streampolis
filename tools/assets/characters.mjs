#!/usr/bin/env node
/**
 * Fatia os personagens modulares em PEÇAS de guarda-roupa.
 *
 * Os pacotes Ultimate Modular da Quaternius trazem cada personagem como um
 * arquivo só com quatro malhas dentro — `Body`, `Legs`, `Feet`, `Head` — e os
 * 21 personagens dividem o mesmo esqueleto de 62 ossos, na mesma ordem. É essa
 * coincidência que faz um guarda-roupa existir: a calça de um veste o corpo de
 * outro sem remapear um índice sequer.
 *
 * O que este passe faz é separar essas malhas em arquivos independentes, para
 * o jogo baixar UMA peça e não o personagem inteiro. Vestir quatro peças de
 * quatro personagens diferentes com os arquivos originais custaria 6 MB para
 * mostrar 1,2 MB de malha.
 *
 * Cada peça sai com o esqueleto inteiro (é o que a deformação exige) e com as
 * animações REMOVIDAS: dentro de um pacote elas são idênticas nos 10 ou 11
 * arquivos, então ficam num `animations_f.glb` e num `animations_m.glb` em vez
 * de vinte e uma cópias.
 *
 * **UM arquivo de animação para os dois pacotes não serve, e isso custou caro.**
 * Os 21 personagens dividem os nomes e a ORDEM dos 62 ossos — é o que faz o
 * guarda-roupa existir —, mas os dois pacotes têm POSES DE BIND diferentes: as
 * dez mulheres numa, os onze homens noutra, com 1,34 de diferença no
 * `Shoulder.L`. As faixas do pacote são rotações ABSOLUTAS, então dar a faixa
 * da mulher ao homem não o põe na pose autorada: põe o braço dele na pose dela
 * MAIS a diferença entre os dois repousos. Na prática, todo avatar masculino do
 * jogo — inclusive o `m_casual_character`, que é o padrão de quem entra —
 * andava pela praça com os dois braços esticados para a frente.
 *
 *   node tools/assets/characters.mjs [--only=women,men]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, textureCompress, weld } from '@gltf-transform/functions';
import { readdir, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VENDOR = path.join(ROOT, 'assets/vendor');
const OUT = path.join(ROOT, 'packages/client/public/assets/wardrobe');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const ONLY = args.only ? new Set(args.only.split(',')) : null;

const PACKS = [
  { id: 'women', dir: 'quaternius-modular-women/extracted', gender: 'f' },
  { id: 'men', dir: 'quaternius-modular-men/extracted', gender: 'm' },
];

/** Sufixo da malha → slot do jogo. O que não estiver aqui não vira peça. */
const SLOT = { Body: 'top', Legs: 'bottom', Feet: 'shoes', Head: 'head' };

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Limpa o CONTEÚDO, nunca a pasta.
 *
 * Apagar e recriar `public/assets/wardrobe` faz o servidor de desenvolvimento
 * do Vite parar de servir tudo que estiver lá dentro — ele passa a devolver o
 * `index.html` para cada `.glb`, e o carregador de glTF morre com "Unexpected
 * token '<'". Duas capturas vazias foram gastas nisso; o diretório fica de pé
 * e só os arquivos são trocados.
 */
await mkdir(OUT, { recursive: true });
for (const old of await readdir(OUT).catch(() => [])) {
  if (/\.(glb|json)$/.test(old)) await rm(path.join(OUT, old), { force: true });
}

/**
 * O FORRO: a pele que fica por baixo da roupa.
 *
 * Este pacote não tem corpo. As quatro peças SÃO o personagem — o `top` traz o
 * pano e os braços, o `bottom` traz as pernas —, e cada personagem foi
 * desenhado como um CONJUNTO: a saia da bruxa para no joelho porque a bota dela
 * sobe até lá. A loja vende as peças separadas, então saia da bruxa com tênis
 * baixo é uma canela de dezoito centímetros de nada, e dá para ver o cenário
 * através do avatar.
 *
 * O pacote não traz corpo nu para este rig — o "Universal Base Characters" da
 * mesma casa é outro esqueleto e não serve. Quem serve é uma peça de baixo, e
 * escolhê-la é um problema de duas medidas ao mesmo tempo: precisa COBRIR (do
 * tornozelo até acima do umbigo, porque é lá que ficam as duas emendas) e
 * precisa CABER (ser mais estreita que a peça mais justa do acervo, ou aparece
 * por cima dela).
 *
 * A primeira escolha olhou só para a cobertura e pegou a calça do alfaiate
 * feminino, que vai de 0,12 m a 1,08 m. Ela cobre e não cabe: medindo o raio a
 * partir do eixo da perna, faixa a faixa (`__lab.pieceProfile`), o punho dela
 * tem 0,310 — quase o mais largo das 42 peças de baixo do acervo, porque é o
 * punho de uma CALÇA e não um tornozelo. O que se via era a bainha do forro
 * saindo por cima do cano do sapato.
 *
 * A calça da `f_animated_woman` alcança quase o mesmo (0,13 a 1,065 — e 1,06 é
 * o mais alto que uma blusa deste acervo sobe pela cintura) e é 3 cm mais
 * estreita no tornozelo, com coxa e cintura iguais ou menores. Das quatro peças
 * do acervo que vão do tornozelo à cintura, é a mais justa.
 *
 * Ela entra tingida com o TOM DE PELE do jogador, não com a cor do tecido: onde
 * ela aparece é justamente onde deveria haver corpo.
 *
 * O buraco da cintura, aliás, é só entre RIGS: as blusas masculinas descem até
 * 0,92 e as femininas param em 1,06, enquanto as calças masculinas sobem só até
 * 0,97. Blusa feminina com calça masculina abre dez centímetros de nada.
 *
 * Não entra no catálogo — ninguém compra o próprio corpo.
 */
const FORRO = [
  { id: 'under_body', pack: 'women', file: 'Animated Woman.glb', suffix: 'Legs' },
];

const catalog = [];

for (const pack of PACKS) {
  if (ONLY && !ONLY.has(pack.id)) continue;
  const dir = path.join(VENDOR, pack.dir);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.glb'));

  for (const file of files) {
    const character = slug(path.basename(file, '.glb'));
    const doc = await io.read(path.join(dir, file));
    const root = doc.getRoot();

    // As animações são as mesmas DENTRO DE UM PACOTE: uma cópia serve para os
    // dez ou onze personagens dele. Entre pacotes elas NÃO servem — ver o
    // cabeçalho deste arquivo —, e é por isso que o nome leva o gênero.
    if (!pack.animationsWritten) {
      const anim = await io.read(path.join(dir, file));
      const ar = anim.getRoot();
      for (const mesh of ar.listMeshes()) mesh.dispose();
      for (const skin of ar.listSkins()) skin.dispose();
      await anim.transform(prune(), dedup());
      await writeFile(path.join(OUT, `animations_${pack.gender}.glb`), await io.writeBinary(anim));
      pack.animationsWritten = true;
    }

    for (const mesh of root.listMeshes()) {
      const name = mesh.getName();
      const suffix = name.split('_').pop() ?? '';
      const slot = SLOT[suffix];
      if (!slot) continue;

      // Uma cópia do documento por peça: apagar as OUTRAS malhas é mais seguro
      // do que montar um documento novo à mão, porque o esqueleto, a pele e os
      // materiais continuam ligados como o autor os deixou.
      const part = await io.read(path.join(dir, file));
      const pr = part.getRoot();
      for (const m of pr.listMeshes()) if (m.getName() !== name) m.dispose();
      // Descartar a animação NÃO descarta os acessores dela: os samplers
      // continuam apontando para as faixas e o `prune()` os considera vivos.
      // Sem soltar sampler e canal um a um, cada peça saía com 946 acessores e
      // 830 KB — de uma malha de 1.514 vértices sem textura nenhuma.
      for (const a of pr.listAnimations()) {
        for (const ch of a.listChannels()) ch.dispose();
        for (const sp of a.listSamplers()) sp.dispose();
        a.dispose();
      }
      await part.transform(
        weld(),
        prune(),
        dedup(),
        // SEM quantizar, e o motivo é uma armadilha que custou uma captura
        // vazia e uma cabeça de três metros: `quantize()` normaliza as posições
        // e compensa com uma TRANSFORMAÇÃO no nó da malha. Uma peça de roupa
        // não fica no nó dela — ela é reamarrada ao esqueleto do corpo, e nessa
        // mudança de pai a compensação se perde. Corta 40% do arquivo e
        // devolve um avatar desmontado; 307 KB por peça é o preço de ela
        // vestir.
        // 512 e não 1024: a textura é um ATLAS do personagem inteiro e cada
        // peça carrega uma cópia dele, então o mapa é o peso do guarda-roupa e
        // não a malha. A 1024 as 83 peças davam 57 MB, e um avatar vestido são
        // quatro delas — ninguém baixa 2,6 MB para ver alguém atravessar a
        // praça.
        textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }),
      );

      const id = `${pack.gender}_${character}_${slot}`;
      const bytes = await io.writeBinary(part);
      await writeFile(path.join(OUT, `${id}.glb`), bytes);
      catalog.push({ id, slot, character, gender: pack.gender, kb: Math.round(bytes.length / 1024) });
      process.stdout.write('·');
    }
  }
}

process.stdout.write('\n');

// O forro, depois das peças: mesmo corte, mas guardando SÓ o primitivo de pele.
for (const forro of FORRO) {
  const pack = PACKS.find((p) => p.id === forro.pack);
  if (!pack || (ONLY && !ONLY.has(pack.id))) continue;
  const doc = await io.read(path.join(VENDOR, pack.dir, forro.file));
  const root = doc.getRoot();
  const alvo = root.listMeshes().find((m) => m.getName().endsWith(`_${forro.suffix}`));
  if (!alvo) { console.error(`forro ${forro.id}: malha *_${forro.suffix} não existe em ${forro.file}`); continue; }
  for (const m of root.listMeshes()) if (m !== alvo) m.dispose();
  // TODOS os primitivos da malha, e não só os de pele: a cobertura é o que
  // importa, e o avatar tinge o forro inteiro com o tom de pele na hora de
  // vestir. Ficar só com a pele do doador deixaria de fora justamente o tecido,
  // que é o que cobre o quadril e a cintura.
  for (const a of root.listAnimations()) {
    for (const ch of a.listChannels()) ch.dispose();
    for (const sp of a.listSamplers()) sp.dispose();
    a.dispose();
  }
  await doc.transform(weld(), prune(), dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }));
  const bytes = await io.writeBinary(doc);
  await writeFile(path.join(OUT, `${forro.id}.glb`), bytes);
  console.log(`forro ${forro.id}: ${Math.round(bytes.length / 1024)} KB`);
}

await writeFile(path.join(OUT, 'catalog.json'), `${JSON.stringify({
  $comment: 'Peças de guarda-roupa fatiadas dos pacotes Ultimate Modular (CC0). Geradas por tools/assets/characters.mjs.',
  parts: catalog,
}, null, 2)}\n`);

/**
 * As peças entram no CATÁLOGO COMPARTILHADO, entre marcadores.
 *
 * A loja, a API e o cliente têm de concordar sobre quais peças existem, e a
 * lista não pode ser digitada à mão — ela sai de arquivos em disco. Um módulo
 * separado seria mais limpo e não funciona: a API roda TypeScript cru no Node e
 * não resolve os `import` internos do pacote compartilhado, então `items.ts`
 * não pode importar um `wardrobe.ts` ao lado dele. Gerar dentro do próprio
 * arquivo mantém UMA fonte, que é o que importa — o catálogo escrito duas vezes
 * já custou um dia a este projeto.
 */
const NOME = {
  adventurer: 'Aventureiro', animated_woman: 'Clássica', animated_woman_niitlv9nxs: 'Clássica II',
  astronaut: 'Astronauta', beach_character: 'Praia', business_man: 'Executivo',
  casual_character: 'Casual', farmer: 'Fazendeiro', hoodie_character: 'Moletom',
  king: 'Realeza', medieval: 'Medieval', punk: 'Punk', sci_fi_character: 'Sci-Fi',
  soldier: 'Militar', suit: 'Alfaiataria', swat: 'Tático', witch: 'Bruxa', worker: 'Operário',
};
const PECA = { head: 'Cabeça', top: 'Blusa', bottom: 'Calça', shoes: 'Calçado' };
/** Slot do protocolo. `head` entra como `hair` porque rosto e cabelo vêm na mesma malha. */
const TIPO = { head: 'hair', top: 'top', bottom: 'bottom', shoes: 'shoes' };
/** Personagens que saem mais caros: silhueta distinta, não roupa de rua. */
const RARO = new Set(['king', 'astronaut', 'sci_fi_character', 'witch', 'swat', 'soldier']);
/** O conjunto que todo mundo já veste ao entrar: de graça, ou não há avatar. */
const GRATIS = new Set(['m_casual_character', 'f_animated_woman']);

const preco = (part) => {
  const chave = `${part.gender}_${part.character}`;
  if (GRATIS.has(chave)) return { rarity: 'common', credits: 0, coins: null };
  if (RARO.has(part.character)) return { rarity: 'epic', credits: null, coins: 320 };
  if (part.slot === 'head') return { rarity: 'rare', credits: 680, coins: null };
  return { rarity: 'common', credits: 320, coins: null };
};

const linhas = catalog.map((part) => {
  const p = preco(part);
  const nome = `${PECA[part.slot]} ${NOME[part.character] ?? part.character}`
    + (part.gender === 'f' ? ' F' : ' M');
  return `  wear('${part.id}', '${TIPO[part.slot]}', '${nome}', '${p.rarity}', `
    + `${p.credits}, ${p.coins}),`;
}).join('\n');

const itemsPath = path.join(ROOT, 'packages/shared/src/items.ts');
const items = await readFile(itemsPath, 'utf8');
const MARCADORES = /(\/\/ <<< GERADO: guarda-roupa[\s\S]*?\n)[\s\S]*?(\n *\/\/ >>> GERADO)/;
// Duas coisas diferentes, e o aviso as confundia: "não achei os marcadores" e
// "achei e já estava igual" davam a mesma mensagem, porque o teste era só
// comparar as strings. Um catálogo em dia era anunciado como catálogo quebrado.
if (!MARCADORES.test(items)) {
  console.warn('! não achei os marcadores em shared/src/items.ts — catálogo NÃO atualizado');
} else {
  const marcado = items.replace(MARCADORES, `$1${linhas}$2`);
  if (marcado === items) {
    console.log(`catálogo compartilhado já estava em dia (${catalog.length} peças)`);
  } else {
    await writeFile(itemsPath, marcado);
    console.log(`catálogo compartilhado atualizado com ${catalog.length} peças`);
  }
}

const total = catalog.reduce((a, p) => a + p.kb, 0);
console.log(`${catalog.length} peças em ${path.relative(ROOT, OUT)} (${(total / 1024).toFixed(1)} MB no total)`);
for (const slot of ['top', 'bottom', 'shoes', 'head']) {
  console.log(`  ${slot.padEnd(7)} ${catalog.filter((p) => p.slot === slot).length}`);
}
