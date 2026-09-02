#!/usr/bin/env node
/**
 * Baixa os pacotes de asset declarados em `assets/manifest.json`.
 *
 * O download fica em `assets/vendor/`, FORA do git. A QAL da Quaternius (e a
 * licença padrão do Fab) permitem incorporar o asset num jogo e proíbem
 * redistribuí-lo como asset solto — e um repositório público cheio de .glb
 * avulsos é exatamente isso. O que o git guarda é a lista, a licença e o
 * passe; quem clona roda `npm run assets` e busca de novo.
 *
 *   node tools/assets/fetch.mjs [--only=kenney-nature,quaternius-city] [--force]
 *
 * Duas origens, dois protocolos:
 *
 * - **kenney.nl** publica o .zip como link direto na própria página do pacote,
 *   atrás de um modal de doação. Basta ler o href.
 * - **itch.io** (Quaternius e KayKit) exige três passos: pegar o `csrf_token`
 *   da página, POST em `/download_url` para receber um endereço com token, e
 *   POST em `/file/<id>` para receber a URL assinada do arquivo. O endpoint
 *   `/file` mora na URL BASE do jogo, não na URL com token — ali dá 404.
 */
import { mkdir, writeFile, readFile, readdir, copyFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');
const VENDOR = path.join(ROOT, 'assets/vendor');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const only = args.only ? new Set(args.only.split(',')) : null;
const force = args.force === 'true';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Um jar de cookies por processo: o itch amarra o csrf_token à sessão. */
const jar = new Map();
function rememberCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function req(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: '*/*',
      ...(jar.size ? { cookie: cookieHeader() } : {}),
      ...init.headers,
    },
  });
  rememberCookies(res);
  return res;
}

const csrfOf = (html) => {
  const m = html.match(/csrf_token"\s+value="([^"]+)"/);
  if (!m) throw new Error('csrf_token não encontrado');
  return m[1];
};

async function kenneyZipUrl(page) {
  const html = await (await req(page)).text();
  const m = html.match(/href='(https:\/\/kenney\.nl\/media\/pages\/assets\/[^']+\.zip)'/)
    ?? html.match(/href="(https:\/\/kenney\.nl\/media\/pages\/assets\/[^"]+\.zip)"/);
  if (!m) throw new Error('link .zip não encontrado na página do Kenney');
  return m[1];
}

async function itchFiles(user, game) {
  const base = `https://${user}.itch.io/${game}`;
  const page = await (await req(base)).text();
  const token = csrfOf(page);

  const urlRes = await req(`${base}/download_url`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ csrf_token: token }).toString(),
  });
  const { url } = await urlRes.json();
  if (!url) throw new Error('itch não devolveu download_url (o pacote pode ser pago)');

  const listing = await (await req(url)).text();
  const listToken = csrfOf(listing);
  const uploads = [...listing.matchAll(/data-upload_id="(\d+)"/g)].map((m) => m[1]);
  const names = [...listing.matchAll(/class="name"[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  if (!uploads.length) throw new Error('nenhum arquivo na página de download do itch');

  const out = [];
  for (let i = 0; i < uploads.length; i++) {
    // O endpoint /file mora na URL BASE do jogo. Na URL com token dá 404, e o
    // 404 do itch é uma página HTML de 200 caracteres que parece um erro de
    // rede — custou tempo.
    const res = await req(`${base}/file/${uploads[i]}?source=game_download&as_props=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest',
        referer: url,
      },
      body: new URLSearchParams({ csrf_token: listToken }).toString(),
    });
    if (!res.ok) continue;
    const body = await res.json();
    if (body.url) out.push({ name: names[i] ?? `file-${uploads[i]}`, url: body.url });
  }
  return out;
}

async function download(url, dest) {
  const res = await req(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url.slice(0, 80)}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return (await stat(dest)).size;
}

const exists = (p) => stat(p).then(() => true, () => false);

/**
 * Conserta referências de textura que o pacote publicou com o nome errado.
 *
 * O Universal Base Characters aponta para `T_Eye_Normal_png.png` e
 * `T_Hair_1_Normal_png.png`, e o que existe na pasta é `T_Eye_Normal.png`.
 * É erro de empacotamento do autor, não nosso — e o glTF simplesmente não abre
 * por causa dele. O conserto é genérico de propósito: se um `uri` some e o
 * mesmo nome sem o sufixo `_png` existe, copia. Assim vale para o próximo
 * pacote com o mesmo deslize, e não vira uma exceção com nome de pacote dentro
 * do fetcher.
 */
async function repairTextureRefs(dir) {
  const gltfs = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.gltf')) gltfs.push(full);
    }
  };
  await walk(dir).catch(() => {});

  let fixed = 0;
  for (const file of gltfs) {
    const json = JSON.parse(await readFile(file, 'utf8'));
    for (const image of json.images ?? []) {
      if (!image.uri || image.uri.startsWith('data:')) continue;
      const target = path.join(path.dirname(file), decodeURIComponent(image.uri));
      if (await exists(target)) continue;
      const alt = target.replace(/_png(\.[a-z]+)$/i, '$1');
      if (alt !== target && await exists(alt)) {
        await copyFile(alt, target);
        fixed++;
      }
    }
  }
  if (fixed) console.log(`  ⟳ ${fixed} textura(s) com nome quebrado no pacote, copiadas`);
}

/**
 * Poly Pizza: o catálogo CC0 que hospeda os pacotes da Quaternius que sumiram
 * do site do autor.
 *
 * Os pacotes "Ultimate Modular Men/Women" são CC0 e continuam anunciados em
 * quaternius.com, mas o botão de download de lá está quebrado (widget do itch
 * com `game: ""`) e eles não estão no perfil do itch. O poly.pizza publica os
 * dois como bundle, sem login: pede-se um token ao endpoint do bundle, o
 * download responde um JSON com a URL do zip já compactado, e é ele que se
 * baixa. Duas requisições, nenhuma conta.
 */
async function polyPizzaZip(bundleId, format = 'glb') {
  await req(`https://poly.pizza/api/bundle/${bundleId}/gettoken`);
  const res = await req(`https://poly.pizza/api/list/${bundleId}/download/${format}`, {
    headers: { referer: `https://poly.pizza/bundle/${bundleId}` },
  });
  const body = await res.json();
  if (!body?.url) throw new Error(`poly.pizza não devolveu url para ${bundleId}`);
  return body.url;
}

async function fetchPack(pack) {
  const dir = path.join(VENDOR, pack.id);
  if (!force && await exists(path.join(dir, '.done'))) {
    console.log(`· ${pack.id} já está em assets/vendor (use --force para refazer)`);
    return;
  }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const files = pack.source === 'kenney'
    ? [{ name: `${pack.id}.zip`, url: await kenneyZipUrl(pack.page) }]
    : pack.source === 'polypizza'
      ? [{ name: `${pack.id}.zip`, url: await polyPizzaZip(pack.bundle, pack.format) }]
      : await itchFiles(pack.itchUser, pack.itchGame);

  // Um pacote do itch costuma trazer Standard/Pro/Source; o Standard é o que
  // um jogo web quer, e o Source é um .blend de centenas de MB.
  const wanted = files.filter((f) => !/source|blend/i.test(f.name));
  const picked = wanted.length ? wanted : files;

  for (const f of picked) {
    const zip = path.join(dir, f.name.replace(/[^\w.\[\]-]+/g, '_'));
    const size = await download(f.url, zip);
    console.log(`  ↓ ${f.name} (${(size / 1e6).toFixed(1)} MB)`);
    // Pelo conteúdo, não pelo nome: o KayKit publica o pacote gratuito com o
    // rótulo "Free", sem extensão nenhuma, e ele é um zip.
    const head = await readFile(zip, { encoding: null }).then((b) => b.subarray(0, 2).toString('binary'));
    if (head === 'PK') {
      await run('unzip', ['-q', '-o', zip, '-d', path.join(dir, 'extracted')], { maxBuffer: 1 << 28 });
      await rm(zip);
    }
  }

  await repairTextureRefs(dir);

  await writeFile(path.join(dir, 'LICENSE.txt'),
    `${pack.name}\nFonte: ${pack.page}\nLicença: ${pack.license}\n${pack.licenseUrl}\n`
    + `Uso no Streampolis: ${pack.use}\nBaixado em: ${new Date().toISOString()}\n`);
  await writeFile(path.join(dir, '.done'), new Date().toISOString());
  console.log(`✓ ${pack.id}`);
}

/**
 * Poly Haven tem API pública e tudo é CC0, então aqui não há dança nenhuma:
 * pergunta os arquivos do HDRI e baixa o .hdr da resolução pedida.
 */
async function fetchHdri(h) {
  const dir = path.join(VENDOR, 'polyhaven');
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${h.id}_${h.res}.hdr`);
  if (!force && await exists(dest)) { console.log(`· hdri ${h.id} já baixado`); return; }
  const files = await (await req(`https://api.polyhaven.com/files/${h.id}`)).json();
  const url = files?.hdri?.[h.res]?.hdr?.url;
  if (!url) throw new Error(`HDRI ${h.id} não tem ${h.res}/hdr`);
  const size = await download(url, dest);
  console.log(`✓ hdri ${h.id} (${(size / 1e6).toFixed(1)} MB)`);
  await writeFile(path.join(dir, 'LICENSE.txt'),
    'Poly Haven — todos os assets são CC0 1.0 (domínio público), inclusive para uso comercial.\n'
    + 'https://polyhaven.com/license\n');
}

const manifest = JSON.parse(await readFile(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
await mkdir(VENDOR, { recursive: true });

const failures = [];
for (const pack of manifest.packs) {
  if (only && !only.has(pack.id)) continue;
  try { await fetchPack(pack); } catch (err) { failures.push(`${pack.id}: ${err.message}`); console.error(`✗ ${pack.id}: ${err.message}`); }
}
for (const h of manifest.hdris ?? []) {
  if (only && !only.has(h.id)) continue;
  try { await fetchHdri(h); } catch (err) { failures.push(`hdri ${h.id}: ${err.message}`); console.error(`✗ hdri ${h.id}: ${err.message}`); }
}

if (failures.length) {
  console.error(`\n${failures.length} pacote(s) falharam:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
