#!/usr/bin/env node
/**
 * Busca e prepara o vídeo do telão da praça (PRD §6).
 *
 * Mesma regra do `fetch.mjs`, pelo mesmo motivo: **o git guarda a receita, não
 * a mídia.** `packages/client/public/assets/` está no `.gitignore`, então um
 * clone limpo constrói um telão sem vídeo — e, sem este arquivo, ninguém
 * saberia por quê. O painel volta sozinho ao visual de LED quando o `.mp4` não
 * está lá (ver `props/Screen.ts`), o que torna a falta silenciosa: bonita, e
 * por isso mesmo difícil de notar.
 *
 *   node tools/assets/telao.mjs [--force]
 *
 * ## O que o encode faz, e por quê
 *
 * - **`-an`, sem faixa de áudio nenhuma.** O elemento já é `muted`, mas um
 *   arquivo sem trilha é uma garantia e não uma configuração — ninguém liga o
 *   som de um vídeo que não tem som. Também tira ~1 MB.
 * - **H.264, não HEVC.** A origem entrega HEVC, que nem todo navegador
 *   decodifica — e o que falha não é o download, é a textura, que fica preta.
 * - **720×1280.** O vídeo ocupa ~4,2 m de um painel de 13,5 m; 1080p seria
 *   decodificar quatro vezes mais pixel para a mesma leitura.
 * - **`+faststart`.** Move o índice para o começo do arquivo: o telão começa a
 *   tocar enquanto baixa, em vez de esperar 4,7 MB.
 *
 * Requer `yt-dlp` com impersonation (`pip install "yt-dlp[default,curl-cffi]"`)
 * e `ffmpeg`. Sem a impersonation o TikTok responde com uma página que o
 * extrator não entende, e o erro não diz isso.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

/** A fonte. Trocar o telão é trocar esta linha e rodar de novo. */
const ORIGEM = 'https://www.tiktok.com/@compositorns/video/7681733274175212820';

const DESTINO = path.resolve('packages/client/public/assets/video/telao.mp4');
const force = process.argv.includes('--force');

const existe = await stat(DESTINO).then(() => true).catch(() => false);
if (existe && !force) {
  console.log(`já existe: ${DESTINO}\nuse --force para refazer`);
  process.exit(0);
}

const tmp = path.join(tmpdir(), `telao-${Date.now()}`);
await mkdir(tmp, { recursive: true });
await mkdir(path.dirname(DESTINO), { recursive: true });

try {
  console.log(`baixando ${ORIGEM}`);
  await run('yt-dlp', [
    '--no-playlist', '--impersonate', 'chrome',
    '-o', path.join(tmp, 'origem.%(ext)s'), ORIGEM,
  ], { maxBuffer: 1 << 24 });

  const bruto = path.join(tmp, 'origem.mp4');
  console.log('convertendo (H.264, sem áudio, 720×1280)');
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', bruto,
    '-an',
    '-vf', 'scale=720:1280:flags=lanczos',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '31', '-maxrate', '1200k', '-bufsize', '2400k', '-g', '48',
    '-movflags', '+faststart',
    DESTINO,
  ], { maxBuffer: 1 << 24 });

  // Conferir que não sobrou trilha de áudio é barato e pega o dia em que
  // alguém tirar o `-an` "só para testar".
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', DESTINO,
  ]);
  const faixas = stdout.trim().split('\n').filter(Boolean);
  if (faixas.some((f) => f.includes('audio'))) {
    throw new Error('o arquivo final tem faixa de áudio — o telão é mudo por contrato');
  }

  const { size } = await stat(DESTINO);
  console.log(`pronto: ${DESTINO} (${Math.round(size / 1024)} KiB, ${faixas.length} faixa de vídeo)`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
