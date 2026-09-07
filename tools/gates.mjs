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
/** A API sob teste é a local? Muda o que cada portão exige do ambiente. */
const ALVO_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(API);

const PORTOES = [
  { nome: 'typecheck:api', grupo: 'unit', cmd: 'npm', argv: ['run', 'typecheck', '--workspace', '@streampolis/api'] },
  { nome: 'typecheck:client', grupo: 'unit', cmd: 'npm', argv: ['run', 'typecheck', '--workspace', '@streampolis/client'] },
  { nome: 'test:api', grupo: 'unit', cmd: 'npm', argv: ['test', '--workspace', '@streampolis/api'] },
  { nome: 'test:game-server', grupo: 'unit', cmd: 'npm', argv: ['test', '--workspace', '@streampolis/game-server'] },
  {
    nome: 'release-check', grupo: 'e2e', needs: ['api', 'ws'],
    // Contra um alvo remoto sem provedor de pagamento, ele credita a conta de
    // teste por dentro — e para isso precisa do banco daquele ambiente.
    env: ALVO_LOCAL ? [] : ['DATABASE_URL'],
    cmd: 'node', argv: ['tools/release-check.mjs', `--api=${API}`, `--ws=${WS}`],
  },
  {
    nome: 'admin-check', grupo: 'e2e', needs: ['api', 'ws'],
    // A equipe entra com senha, e a senha da produção não é a do seed.
    env: ALVO_LOCAL ? [] : ['STAFF_PASSWORD'],
    cmd: 'node', argv: ['tools/admin-check.mjs', `--api=${API}`, `--ws=${WS}`],
  },
  { nome: 'agency-check', grupo: 'e2e', needs: ['api'], cmd: 'node', argv: ['tools/agency-check.mjs', `--api=${API}`] },
  {
    nome: 'critical-check', grupo: 'e2e', needs: ['api', 'ws'],
    // Os três testes que os SPECs chamam de críticos (§61–§63). Contra alvo
    // remoto precisa dos segredos daquele ambiente: as rotas /internal são a
    // porta do game server, e o webhook é assinado.
    env: ALVO_LOCAL ? [] : ['API_SERVICE_TOKEN', 'PAYMENT_WEBHOOK_SECRET'],
    cmd: 'node', argv: ['tools/critical-check.mjs', `--api=${API}`, `--ws=${WS}`],
  },
  {
    nome: 'gigs-check', grupo: 'e2e', needs: ['api', 'ws'],
    // Os bicos de rua (§26) atravessam as três autoridades, e os dois passos
    // que provam idempotência e ordem entram pela porta do game server.
    env: ALVO_LOCAL ? [] : ['API_SERVICE_TOKEN'],
    cmd: 'node', argv: ['tools/gigs-check.mjs', `--api=${API}`, `--server=${WS}`],
  },
  {
    nome: 'events-check', grupo: 'e2e', needs: ['api'],
    // Eventos da cidade (§22/§28). Não precisa do game server: o que ele prova
    // é a APURAÇÃO — a única rotina do jogo que emite Credits sem ninguém
    // pedir. Criar evento é rota de equipe, e a senha da produção não é a do
    // seed.
    env: ALVO_LOCAL ? [] : ['STAFF_PASSWORD'],
    cmd: 'node', argv: ['tools/events-check.mjs', `--api=${API}`],
  },
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
    // Faltar variável de ambiente é motivo de PULAR, não de falhar: um portão
    // vermelho porque quem rodou esqueceu de exportar uma senha não é
    // informação sobre o código — é ruído que ensina a ignorar vermelho.
    const faltaEnv = (portao.env ?? []).filter((v) => !process.env[v]);
    if (falta.length > 0 || faltaEnv.length > 0) {
      const motivo = [
        falta.length ? `sem ${falta.join(' e ')}` : '',
        faltaEnv.length ? `sem ${faltaEnv.join(' e ')} no ambiente` : '',
      ].filter(Boolean).join(', ');
      resultados.push({ ...portao, estado: 'pulado', motivo });
      console.log(`  ${cor('–', 33)} ${portao.nome} ${cor(`(pulado: ${motivo})`, 33)}`);
      continue;
    }

    process.stdout.write(`  … ${portao.nome}`);
    const r = await rodar(portao);
    /**
     * Um e2e que termina em 0 e NÃO diz quantas verificações passaram é
     * suspeito, não aprovado. Foi assim que o critical-check "passou" por dois
     * runs: uma promessa que nunca resolvia drenava o loop de eventos e o Node
     * encerrava sozinho, com código 0 e sem placar. Confiar só no código de
     * saída é confiar no silêncio.
     */
    const placarDele = placar(r.saida);
    const mudo = portao.grupo === 'e2e' && r.ok && !placarDele;
    const ok = r.ok && !mudo;
    const marca = ok ? cor('✓', 32) : cor('✗', 31);
    process.stdout.write(`\r  ${marca} ${portao.nome} ${cor(`${r.segundos}s`, 90)} `
      + `${mudo ? cor('terminou sem placar', 31) : placarDele}\n`);
    resultados.push({ ...portao, estado: ok ? 'passou' : 'falhou', saida: r.saida });
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
    for (const p of pulados) console.log(cor(`   · ${p.nome}: ${p.motivo}`, 90));
  }
  process.exit(falhou.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 runner falhou:', err?.message ?? err);
  process.exit(1);
});
