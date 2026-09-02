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
 * animações REMOVIDAS: elas são idênticas nos 21 arquivos, então ficam num
 * único `animations.glb` em vez de vinte e uma cópias.
 *
 *   node tools/assets/characters.mjs [--only=women,men]
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, textureCompress, weld } from '@gltf-transform/functions';
import { readdir, mkdir, writeFile, rm } from 'node:fs/promises';
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

const catalog = [];
let animationsWritten = false;

for (const pack of PACKS) {
  if (ONLY && !ONLY.has(pack.id)) continue;
  const dir = path.join(VENDOR, pack.dir);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.glb'));

  for (const file of files) {
    const character = slug(path.basename(file, '.glb'));
    const doc = await io.read(path.join(dir, file));
    const root = doc.getRoot();

    // As animações são as mesmas nos 21 arquivos: uma cópia serve para todos.
    if (!animationsWritten) {
      const anim = await io.read(path.join(dir, file));
      const ar = anim.getRoot();
      for (const mesh of ar.listMeshes()) mesh.dispose();
      for (const skin of ar.listSkins()) skin.dispose();
      await anim.transform(prune(), dedup());
      await writeFile(path.join(OUT, 'animations.glb'), await io.writeBinary(anim));
      animationsWritten = true;
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
await writeFile(path.join(OUT, 'catalog.json'), `${JSON.stringify({
  $comment: 'Peças de guarda-roupa fatiadas dos pacotes Ultimate Modular (CC0). Geradas por tools/assets/characters.mjs.',
  parts: catalog,
}, null, 2)}\n`);

const total = catalog.reduce((a, p) => a + p.kb, 0);
console.log(`${catalog.length} peças em ${path.relative(ROOT, OUT)} (${(total / 1024).toFixed(1)} MB no total)`);
for (const slot of ['top', 'bottom', 'shoes', 'head']) {
  console.log(`  ${slot.padEnd(7)} ${catalog.filter((p) => p.slot === slot).length}`);
}
