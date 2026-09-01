#!/usr/bin/env node
/**
 * O "Streampolis pass": o que transforma um asset de terceiro em asset nosso.
 *
 * A regra é a do dono: **nenhum asset entra no jogo sem passar por aqui**, e
 * ninguém deve conseguir dizer "esse prédio é Quaternius e esse banco é
 * Kenney". Sete pacotes com sete escalas, sete paletas e sete convenções de
 * origem viram uma colagem; o passe é o que os alinha:
 *
 * 1. **escala** — cada modelo é medido e reescalado para uma altura (ou largura)
 *    declarada em METROS, a mesma unidade do resto do jogo;
 * 2. **origem** — apoiado no chão e centrado na planta, para que o código de
 *    posicionamento só precise de posição, giro e escala;
 * 3. **paleta** — `baseColorFactor` puxado para a cor da família, o que
 *    preserva a variação interna da textura e muda só o matiz;
 * 4. **material** — rugosidade e metalicidade trazidas para a faixa do jogo
 *    (nada neste mundo é espelho) e emissivo de terceiro zerado;
 * 5. **otimização** — dedup, weld, join, prune e textura reduzida ao teto;
 * 6. **empacotamento** — um GLB POR FAMÍLIA, com cada variante como um nó
 *    nomeado. Treze árvores em treze arquivos são treze requisições e treze
 *    cópias do mesmo atlas de casca;
 * 7. **colisão** — um cilindro ou caixa por variante, escrito no catálogo, para
 *    a tabela compartilhada não depender da malha.
 *
 *   node tools/assets/pass.mjs [--only=tree,building] [--inspect]
 *
 * `--inspect` só mede e imprime: é como se descobrem as alturas naturais de um
 * pacote novo antes de escrever o alvo na curadoria.
 */
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, join, flatten, textureCompress, mergeDocuments, unpartition, resample } from '@gltf-transform/functions';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VENDOR = path.join(ROOT, 'assets/vendor');
const OUT = path.join(ROOT, 'packages/client/public/assets');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const only = args.only ? new Set(args.only.split(',')) : null;
const inspect = args.inspect === 'true';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hexLinear(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear);
}

/** Bounding box of everything reachable from a node, in that node's parent space. */
function bounds(node) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const walk = (n, m) => {
    const local = mul(m, trs(n));
    const mesh = n.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        for (let i = 0; i < pos.getCount(); i++) {
          const p = apply(local, pos.getElement(i, [0, 0, 0]));
          for (let k = 0; k < 3; k++) {
            if (p[k] < min[k]) min[k] = p[k];
            if (p[k] > max[k]) max[k] = p[k];
          }
        }
      }
    }
    for (const child of n.listChildren()) walk(child, local);
  };
  walk(node, identity());
  return { min, max };
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function trs(node) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const [x, y, z, w] = r;
  const m = [
    (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
    (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
    (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = v;
  }
  return o;
}
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/**
 * Puxa cada material para a paleta da família e para a faixa de material do
 * jogo. O tinte multiplica o `baseColorFactor`, então a variação interna da
 * textura sobrevive e só o matiz anda — recolorir o pixel apagaria o desenho
 * que faz o asset ser bom.
 */
function streampolisMaterials(doc, spec) {
  const tint = spec.tint ? hexLinear(spec.tint) : null;
  const amount = spec.tintAmount ?? 0;
  for (const mat of doc.getRoot().listMaterials()) {
    const base = mat.getBaseColorFactor();
    if (tint && amount > 0) {
      mat.setBaseColorFactor([
        base[0] * (1 - amount) + tint[0] * amount * (base[0] * 0.4 + 0.6),
        base[1] * (1 - amount) + tint[1] * amount * (base[1] * 0.4 + 0.6),
        base[2] * (1 - amount) + tint[2] * amount * (base[2] * 0.4 + 0.6),
        base[3],
      ]);
    }
    // Nada neste mundo é espelho: a regra já valia para o que é procedural e
    // passa a valer para o que vem de fora.
    mat.setRoughnessFactor(Math.min(1, Math.max(spec.roughnessMin ?? 0.55, mat.getRoughnessFactor())));
    mat.setMetallicFactor(Math.min(spec.metalnessMax ?? 0.05, mat.getMetallicFactor()));
    mat.setEmissiveFactor([0, 0, 0]);
    if (spec.doubleSided) mat.setDoubleSided(true);
  }
}

async function loadModel(file) {
  const doc = await io.read(file);
  await doc.transform(flatten(), dedup(), join(), weld(), prune());
  return doc;
}

/** Every root node of a document's default scene, as one list. */
const sceneRoots = (doc) => doc.getRoot().listScenes()[0]?.listChildren() ?? [];

/**
 * Família de malha SKINADA — o caminho separado, e ele existe por um motivo
 * duro: o passe normal chama `flatten()` e `join()`, e achatar uma malha
 * skinada destrói o vínculo dela com o esqueleto. Personagem não pode passar
 * por lá.
 *
 * Aqui cada modelo vira o SEU GLB, com o rig e a topologia como o autor
 * entregou. É essa fidelidade que faz a biblioteca de animação do mesmo autor
 * tocar sem retarget nenhum: mesmos 65 ossos, mesmos nomes.
 */
async function buildSkinnedFamily(name, spec) {
  const out = [];
  await mkdir(path.join(OUT, name), { recursive: true });

  for (const entry of spec.models) {
    const doc = await io.read(path.join(VENDOR, entry.file));
    if (inspect) {
      const root = doc.getRoot();
      let tris = 0;
      for (const mesh of root.listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const idx = prim.getIndices();
          tris += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
        }
      }
      console.log(`${name.padEnd(9)} ${entry.id.padEnd(12)} ${Math.round(tris)} tri · `
        + `${root.listSkins()[0]?.listJoints().length ?? 0} ossos · `
        + `${root.listAnimations().length} animações`);
      continue;
    }

    // Um pacote de ANIMAÇÃO não precisa da malha que veio junto: as faixas
    // referenciam os ossos pelo nome, e o esqueleto sobrevive sozinho. Jogar a
    // malha fora derruba o arquivo de 7,3 MB para uma fração disso, e é a
    // diferença entre "cabe num carregamento de cena" e "não cabe".
    if (entry.id === 'animations') {
      // Só as faixas que o experimento usa. As 43 do pacote custam 7,3 MB de
      // keyframe — o peso é a animação, não a malha, e mandar 43 para o
      // navegador por causa de 3 é o tipo de coisa que ninguém percebe até o
      // primeiro carregamento no celular.
      if (entry.keep) {
        const keep = new Set(entry.keep);
        for (const anim of doc.getRoot().listAnimations()) {
          if (!keep.has(anim.getName())) anim.dispose();
        }
      }
      for (const mesh of doc.getRoot().listMeshes()) mesh.dispose();
      for (const skin of doc.getRoot().listSkins()) skin.dispose();
      for (const mat of doc.getRoot().listMaterials()) mat.dispose();
      for (const tex of doc.getRoot().listTextures()) tex.dispose();
      for (const node of doc.getRoot().listNodes()) node.setMesh(null).setSkin(null);
      // `prune` só aqui: sem malha não há skin para ele estragar, e é ele que
      // libera os accessors das faixas descartadas. Sem esta linha o arquivo
      // continua carregando os keyframes das 35 animações que já foram
      // jogadas fora.
      await doc.transform(prune());
    }

    // Sem flatten, sem join, sem weld. Só o que não toca em vértice.
    await doc.transform(
      dedup(),
      // Corta keyframe redundante: o exportador grava toda amostra de todo
      // osso, inclusive as constantes.
      resample(),
      unpartition(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [spec.texture ?? 1024, spec.texture ?? 1024] }),
    );
    const glb = await io.writeBinary(doc);
    await writeFile(path.join(OUT, name, `${entry.id}.glb`), glb);

    const root = doc.getRoot();
    out.push({
      id: entry.id,
      family: name,
      weight: 1,
      pack: entry.pack ?? spec.pack,
      license: entry.license ?? spec.license,
      size: [0, 0, 0],
      joints: root.listSkins()[0]?.listJoints().length ?? 0,
      animations: root.listAnimations().map((a) => a.getName()),
      collider: { kind: 'none', radius: 0, height: 0 },
    });
    console.log(`✓ ${name}/${entry.id}.glb  ${(glb.byteLength / 1e6).toFixed(2)} MB`);
  }
  return inspect ? null : out;
}

async function buildFamily(name, spec) {
  const family = new Document();
  const scene = family.createScene(name);
  const catalog = [];

  for (const entry of spec.models) {
    const file = path.join(VENDOR, entry.file);
    const doc = await loadModel(file);
    const merged = { ...spec, ...entry };
    streampolisMaterials(doc, merged);

    // COLOR_0 quer dizer coisas diferentes em pacotes diferentes. Na vegetação
    // é o tinte por vértice que dá variação à copa sem uma textura por árvore;
    // no kit de cidade é uma MÁSCARA de desgaste, quase preta, que o Unreal
    // usa num canal separado — multiplicá-la no albedo pinta o prédio inteiro
    // de preto. Foi exatamente o que a primeira captura mostrou.
    if (merged.vertexColor === false) {
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) prim.setAttribute('COLOR_0', null);
      }
    }

    // Wrap the source scene in one node so scale and offset are ours, not the
    // exporter's.
    const wrapper = doc.createNode(entry.id);
    for (const root of sceneRoots(doc)) wrapper.addChild(root);

    const b = bounds(wrapper);
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    if (inspect) {
      console.log(`${name.padEnd(9)} ${entry.id.padEnd(26)} ${size.map((v) => v.toFixed(2)).join(' × ')} m`);
      continue;
    }

    // Scale to the declared metre size, then stand it on the floor with its
    // footprint centred: placement code should never have to know that one
    // exporter wrote its origin at the roof.
    //
    // `size: [w, h, d]` permite escala NÃO uniforme, com `null` em qualquer
    // eixo para ele seguir os outros. Mobília precisa disso: o KayKit é
    // autorado grosso de propósito — o sofá dele tem a proporção certa e a mesa
    // de jantar tem 1 m de altura para 3 m de largura. Esticar 15% em Y numa
    // mesa baixa é invisível; escalar tudo pela largura entrega uma mesa de
    // 23 cm, e pela altura, uma de 2 m de largura.
    const per = entry.size ?? spec.size ?? null;
    let k = [1, 1, 1];
    if (per) {
      const uniform = per.map((v, i) => (v == null ? null : v / Math.max(1e-4, size[i])));
      const fallback = uniform.find((v) => v != null) ?? 1;
      k = uniform.map((v) => v ?? fallback);
    } else {
      const target = entry.height ?? spec.height;
      const u = target ? target / Math.max(1e-4, size[1]) : (entry.scale ?? 1);
      k = [u, u, u];
    }
    wrapper.setScale(k);
    wrapper.setTranslation([
      -((b.min[0] + b.max[0]) / 2) * k[0],
      -b.min[1] * k[1],
      -((b.min[2] + b.max[2]) / 2) * k[2],
    ]);

    doc.getRoot().listScenes().forEach((s) => s.dispose());
    const wrapped = doc.createScene(`${entry.id}__tmp`);
    wrapped.addChild(wrapper);

    mergeDocuments(family, doc);
    // merge() copies scenes; move the copy's children into the family scene
    // and drop the empty shell it arrived in.
    for (const s of family.getRoot().listScenes()) {
      if (s === scene) continue;
      for (const child of s.listChildren()) scene.addChild(child);
      s.dispose();
    }

    catalog.push({
      id: entry.id,
      family: name,
      weight: entry.weight ?? 1,
      pack: entry.pack ?? spec.pack,
      license: entry.license ?? spec.license,
      size: [size[0] * k[0], size[1] * k[1], size[2] * k[2]].map((v) => +v.toFixed(3)),
      // Colisão simplificada: um cilindro pela pegada, que é tudo que um
      // jogador precisa não atravessar. A malha não entra na física.
      collider: entry.collider ?? {
        kind: spec.collider ?? 'none',
        radius: +(Math.max(size[0] * k[0], size[2] * k[2]) * 0.5 * (spec.colliderScale ?? 1)).toFixed(3),
        height: +(size[1] * k[1]).toFixed(3),
      },
    });
  }

  if (inspect) return null;

  await family.transform(
    dedup(),
    prune(),
    // Cada documento de origem traz o próprio buffer, e um GLB só admite um.
    unpartition(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [spec.texture ?? 512, spec.texture ?? 512] }),
  );

  // Recolorir o atlas, quando a família pede. É a única forma de puxar um
  // pacote inteiro para a paleta: o KayKit pinta a cor no atlas, não no
  // material, e um `baseColorFactor` azul sobre um sofá amarelo devolve
  // marrom. Modular saturação e matiz preserva o desenho e move o pacote todo
  // junto — que é o que "recolorido para manter a identidade" quer dizer.
  if (spec.modulate) {
    for (const tex of family.getRoot().listTextures()) {
      const image = tex.getImage();
      if (!image) continue;
      const out = await sharp(Buffer.from(image))
        .modulate(spec.modulate)
        .webp({ quality: 90 })
        .toBuffer();
      tex.setImage(new Uint8Array(out)).setMimeType('image/webp');
    }
  }

  await mkdir(OUT, { recursive: true });
  const glb = await io.writeBinary(family);
  await writeFile(path.join(OUT, `${name}.glb`), glb);
  console.log(`✓ ${name}.glb  ${(glb.byteLength / 1e6).toFixed(2)} MB  ${catalog.length} variantes`);
  return catalog;
}

const curation = JSON.parse(await readFile(path.join(ROOT, 'assets/curation.json'), 'utf8'));
// `--only` NÃO limpa a pasta: limpar apagava as outras famílias e o catálogo
// saía com um item só, o que só se descobre quando a praça fica sem árvore.
if (!inspect && !only) await rm(OUT, { recursive: true, force: true });

const catalog = [];
for (const [name, spec] of Object.entries(curation.families)) {
  if (only && !only.has(name)) {
    // Uma família que não foi reconstruída ainda precisa constar do catálogo,
    // senão o `--only` publica um catálogo que esquece o resto do mundo.
    try {
      const old = JSON.parse(await readFile(path.join(OUT, 'catalog.json'), 'utf8'));
      catalog.push(...old.items.filter((i) => i.family === name));
    } catch { /* primeira execução */ }
    continue;
  }
  const rows = spec.skinned ? await buildSkinnedFamily(name, spec) : await buildFamily(name, spec);
  if (rows) catalog.push(...rows);
}

/**
 * O HDRI não passa por transformação: é CC0, já vem em equirretangular e o
 * três lê .hdr direto. O que ele precisa é ATRAVESSAR o passe — chegar em
 * `public/assets` junto do resto, para o cliente ter um lugar só de onde puxar
 * asset e para a licença viajar com o build.
 */
async function copyHdris() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
  const out = [];
  for (const h of manifest.hdris ?? []) {
    const src = path.join(VENDOR, 'polyhaven', `${h.id}_${h.res}.hdr`);
    try {
      const buf = await readFile(src);
      await mkdir(path.join(OUT, 'env'), { recursive: true });
      await writeFile(path.join(OUT, 'env', `${h.id}.hdr`), buf);
      out.push({ id: h.id, family: 'hdri', pack: 'Poly Haven', license: h.license, use: h.use });
      console.log(`✓ env/${h.id}.hdr  ${(buf.byteLength / 1e6).toFixed(2)} MB`);
    } catch {
      console.warn(`· hdri ${h.id} não está em assets/vendor (rode tools/assets/fetch.mjs)`);
    }
  }
  return out;
}

if (!inspect) {
  await mkdir(OUT, { recursive: true });
  catalog.push(...await copyHdris());
  await writeFile(path.join(OUT, 'catalog.json'), JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Gerado por tools/assets/pass.mjs. Não editar à mão; editar assets/curation.json.',
    items: catalog,
  }, null, 1));
  // A licença viaja COM o build: quem recebe o jogo recebe a procedência.
  await writeFile(path.join(OUT, 'LICENSES.txt'),
    [...new Set(catalog.map((c) => `${c.pack} — ${c.license}`))].sort().join('\n') + '\n');
  console.log(`✓ catalog.json (${catalog.length} itens)`);
}
