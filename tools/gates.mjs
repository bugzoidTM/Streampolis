#!/usr/bin/env node
/**
 * Todos os portões, de uma vez.
 *
 * O repositório acumulou seis provas independentes — suítes de unidade, o
 * release-check, o painel, as agências —, cada uma com o seu comando. Enquanto
 * rodá-las depender de alguém LEMBRAR de cada uma, o valor delas é menor do que
 * parece: a que ninguém lembra é a que quebra.
 *
 *   node tools/gates.mjs                       # tudo o que roda sem servidor + os e2e locais
 *   node tools/gates.mjs --only=unit           # só o que não precisa de nada no ar
 *   node tools/gates.mjs --api=… --ws=…        # e2e contra outro alvo (produção, por exemplo)
 *   node tools/gates.mjs --skip=admin,agency
 *
 * ## O que ele NÃO faz
 *
 * Não sobe servidor. Um runner que levanta a stack sozinho parece conveniente e
 * mente sobre o ambiente: o que você quer saber é se os portões passam CONTRA O
 * QUE ESTÁ NO AR, e um servidor que o próprio teste subiu não é isso. Quando a
 * API ou o game server não respondem, os e2e que dependem deles são PULADOS com
 * aviso — e pular aparece no resumo, porque um portão pulado em silêncio é a
 * mesma coisa que um portão que não existe.
 */
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const API = (args.api ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = (args.ws ?? 'ws://127.0.0.1:2567').replace(/\/$/, '');
const HEALTH = args.health ?? (WS.startsWith('wss')
  ? WS.replace(/^wss/, 'https')
  : WS.replace(/^ws/, 'http'));
const ONLY = args.only ?? '';
const SKIP = new Set((args.skip ?? '').split(',').filter(Boolean));

const cor = (t, c) => `[${c}m${t}[0m`;

/**
 * `needs` diz de que ambiente o portão depende. É o que permite pular com
 * honestidade em vez de falhar por motivo errado — um e2e vermelho porque a API
 * está desligada não é informação sobre o código.
 */
const PORTOES = [
  { nome: 'typecheck:api', grupo: 'unit', cmd: 'npm', argv: ['run', 'typecheck', '--workspace', '@streampolis/api'] },
  { nome: 'typecheck:client', grupo: 'unit', cmd: 'npm', argv: ['run', 'typecheck', '--workspace', '@streampolis/client'] },
  { nome: 'test:api', grupo: 'unit', cmd: 'npm', argv: ['test', '--workspace', '@streampolis/api'] },
  { nome: 'test:game-server', grupo: 'unit', cmd: 'npm', argv: ['test', '--workspace', '@streampolis/game-server'] },
  { nome: 'release-check', grupo: 'e2e', needs: ['api', 'ws'], cmd: 'node', argv: ['tools/release-check.mjs', `--api=${API}`, `--ws=${WS}`] },
  { nome: 'admin-check', grupo: 'e2e', needs: ['api', 'ws'], cmd: 'node', argv: ['tools/admin-check.mjs', `--api=${API}`, `--ws=${WS}`] },
  { nome: 'agency-check', grupo: 'e2e', needs: ['api'], cmd: 'node', argv: ['tools/agency-check.mjs', `--api=${API}`] },
];

async function noAr(url, ms = 4_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

function rodar(portao) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const filho = spawn(portao.cmd, portao.argv, {
      cwd: '/root/streampolis',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { saida += d; });
    filho.on('close', (code) => {
      resolve({ ok: code === 0, code, saida, segundos: Math.round((Date.now() - inicio) / 100) / 10 });
    });
  });
}

/** A linha que resume um e2e: "✅ 67/67". Serve para o resumo caber na tela. */
function placar(saida) {
  const m = /(\d+)\/(\d+) verificações passaram/.exec(saida);
  if (m) return `${m[1]}/${m[2]}`;
  const t = /# pass (\d+)/.exec(saida);
  const f = /# fail (\d+)/.exec(saida);
  if (t) return `${t[1]} testes${f && f[1] !== '0' ? `, ${f[1]} falhas` : ''}`;
  return '';
}

async function main() {
  const apiNoAr = await noAr(`${API}/health`);
  const wsNoAr = await noAr(`${HEALTH}/health`);
  console.log(`\nPortões — API ${API} ${apiNoAr ? cor('no ar', 32) : cor('fora', 33)}`
    + ` · game server ${WS} ${wsNoAr ? cor('no ar', 32) : cor('fora', 33)}`);

  const disponivel = { api: apiNoAr, ws: wsNoAr };
  const resultados = [];

  for (const portao of PORTOES) {
    if (ONLY && portao.grupo !== ONLY) continue;
    if (SKIP.has(portao.nome) || SKIP.has(portao.nome.replace('-check', ''))) {
      resultados.push({ ...portao, estado: 'pulado', motivo: 'pedido com --skip' });
      console.log(`  ${cor('–', 90)} ${portao.nome} (pulado)`);
      continue;
    }
    const falta = (portao.needs ?? []).filter((n) => !disponivel[n]);
    if (falta.length > 0) {
      resultados.push({ ...portao, estado: 'pulado', motivo: `sem ${falta.join(' e ')}` });
      console.log(`  ${cor('–', 33)} ${portao.nome} ${cor(`(pulado: sem ${falta.join(' e ')})`, 33)}`);
      continue;
    }

    process.stdout.write(`  … ${portao.nome}`);
    const r = await rodar(portao);
    const marca = r.ok ? cor('✓', 32) : cor('✗', 31);
    process.stdout.write(`\r  ${marca} ${portao.nome} ${cor(`${r.segundos}s`, 90)} ${placar(r.saida)}\n`);
    resultados.push({ ...portao, estado: r.ok ? 'passou' : 'falhou', saida: r.saida });
  }

  const falhou = resultados.filter((r) => r.estado === 'falhou');
  const pulados = resultados.filter((r) => r.estado === 'pulado');

  for (const r of falhou) {
    console.log(`\n${cor(`── ${r.nome} ──`, 31)}`);
    // As últimas linhas são onde o motivo aparece nestes portões; o log inteiro
    // de sete comandos afogaria justamente o que interessa.
    console.log(r.saida.trim().split('\n').slice(-25).join('\n'));
  }

  const passou = resultados.filter((r) => r.estado === 'passou').length;
  console.log(`\n${falhou.length === 0 ? cor('✅', 32) : cor('❌', 31)} ${passou} portões passaram`
    + `${falhou.length ? `, ${falhou.length} falharam` : ''}`
    + `${pulados.length ? `, ${pulados.length} pulados (${pulados.map((p) => p.nome).join(', ')})` : ''}`);

  if (pulados.length > 0 && falhou.length === 0) {
    console.log(cor('   atenção: portão pulado não é portão verde.', 33));
  }
  process.exit(falhou.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 runner falhou:', err?.message ?? err);
  process.exit(1);
});
