#!/usr/bin/env node
/**
 * Soak SOCIAL: quatro pessoas artificiais visitam a cidade de PRODUÇÃO ao
 * longo de horas, em horários diferentes, e o que se mede é o COMPORTAMENTO
 * SOCIAL dos cognitivos (Nilo, Dalva) diante delas — sem tocar em nada do
 * personagem durante a rodada.
 *
 *   node scripts/soak-social.mjs --users=<json do load-users> [--hours=6] [--out=<dir>] [--smoke]
 *
 * As personas são clientes Colyseus iguais ao navegador (token assinado com
 * SP_JWT_SECRET, como o `tools/load-test.mjs`), com o mesmo corpo de pernas
 * do worker (`World` + `Walker` do dist) para andar de verdade pela planta.
 *
 * Quem são:
 *   - Marina  — conversadora, praça. Conta fatos sobre si na 1ª visita e, nas
 *               seguintes, pergunta se o Nilo lembra (reconhecimento/memória);
 *               na 3ª diz que está ocupada e fica calada ao lado (insistência).
 *   - Tadeu   — passante mudo, praça. Só passa a 3–4 m do Nilo, para, segue.
 *               Nunca fala (iniciativa com desconhecido e com conhecido mudo).
 *   - Lu      — conversadora, Distrito Sombra, com a Dalva (mesmo roteiro de
 *               fatos e reconhecimento).
 *   - Caio    — errante: "oi" sem nome de frente para o personagem (árbitro),
 *               uma pergunta, vai embora; depois volta mudo.
 *
 * Saída: um JSONL de eventos (tudo o que cada persona viu e fez, com posição
 * e distância ao personagem) que `soak-social-report.mjs` transforma nas
 * métricas: iniciativa, reconhecimento, repetição, memória, insistência e
 * interações iniciadas pelo personagem.
 */
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true']; }));

process.env.GAME_SERVER_URL = args.ws ?? 'wss://streampolis.nutef.com/ws';
delete process.env.GAME_PUBLIC_PREFIX;
delete process.env.GAME_INTERNAL_HOST;

const SECRET = process.env.SP_JWT_SECRET ?? '';
if (!SECRET) { console.error('SP_JWT_SECRET ausente (set -a; . /root/streampolis-deploy/.env; set +a)'); process.exit(2); }
if (!args.users) { console.error('--users=<arquivo json do load-users> é obrigatório'); process.exit(2); }

const { World } = await import('../dist/npc/src/world.js');
const { nearestFree, insideArea } = await import('../dist/npc/src/scenes.js');

const SMOKE = args.smoke === 'true';
const HOURS = Number(args.hours ?? 6);
const OUT_DIR = args.out ?? '/root/streampolis-soak';
mkdirSync(OUT_DIR, { recursive: true });
const STAMP = args.stamp ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
const LOG = join(OUT_DIR, `social-${STAMP}.jsonl`);
const T0 = Date.now();

const NPC = {
  nilo: { id: '5e1f0000-0000-4000-8000-000000000001', name: 'Nilo', scene: 'central_plaza' },
  dalva: { id: '5e1f0000-0000-4000-8000-000000000002', name: 'Dalva', scene: 'noir_district' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
function log(ev) {
  const line = { t: new Date().toISOString(), min: +((Date.now() - T0) / 60_000).toFixed(2), ...ev };
  appendFileSync(LOG, JSON.stringify(line) + '\n');
  if (ev.type !== 'pos') console.log(`[${line.min.toFixed(1).padStart(5)}m] ${ev.persona ?? '-'}${ev.visit ? `#${ev.visit}` : ''} ${ev.type}${ev.text ? `: ${ev.text}` : ''}${ev.note ? ` (${ev.note})` : ''}`);
}

// ------------------------------------------------------------------ token
const AVATARS = {
  f1: { bodyPreset: 0, skinTone: 4, facePreset: 0, hair: 'f_animated_woman_head', hairColor: 2, top: 'f_animated_woman_top', bottom: 'f_animated_woman_bottom', shoes: 'f_animated_woman_shoes', accessory: '', height: 1, body: 'v1' },
  f2: { bodyPreset: 0, skinTone: 2, facePreset: 0, hair: 'f_adventurer_head', hairColor: 5, top: 'f_adventurer_top', bottom: 'f_adventurer_bottom', shoes: 'f_adventurer_shoes', accessory: '', height: 0.98, body: 'v1' },
  m1: { bodyPreset: 0, skinTone: 5, facePreset: 0, hair: 'm_hoodie_character_head', hairColor: 1, top: 'm_hoodie_character_top', bottom: 'm_hoodie_character_bottom', shoes: 'm_hoodie_character_shoes', accessory: '', height: 1.02, body: 'v1' },
  m2: { bodyPreset: 0, skinTone: 3, facePreset: 0, hair: 'm_business_man_head', hairColor: 0, top: 'm_business_man_top', bottom: 'm_business_man_bottom', shoes: 'm_business_man_shoes', accessory: '', height: 1, body: 'v1' },
};
function signToken(userId, name, avatar) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ name, perms: ['play'], gifterLevel: 0, agency: '', avatar, sid: `soak_${STAMP}_${userId.slice(0, 8)}`, sub: userId, iss: 'streampolis-api', iat: now, exp: now + 3_600 });
  return `${header}.${payload}.${createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')}`;
}

// ----------------------------------------------------- onde está o personagem
// Fora dos 24 m da área de interesse o corpo do personagem não chega ao cliente;
// o /health do worker (rede interna) diz onde ele está, via docker exec.
let npcCid = null;
let healthCache = { at: 0, data: null };
async function npcPositions() {
  if (Date.now() - healthCache.at < 10_000) return healthCache.data;
  try {
    if (!npcCid) npcCid = (await exec('docker', ['ps', '--filter', 'name=streampolis_sp-npc', '-q'])).stdout.trim().split('\n')[0];
    const { stdout } = await exec('docker', ['exec', npcCid, 'node', '-e',
      "fetch('http://127.0.0.1:8791/health').then(r=>r.json()).then(h=>console.log(JSON.stringify(Object.fromEntries(h.agents.filter(a=>a.kind==='cognitive').map(a=>[a.npc,{room:a.room,scene:a.scene,connected:a.connected,position:a.position,action:a.mind?.action,intention:a.mind?.intention?.goal}])))))"], { timeout: 15_000 });
    healthCache = { at: Date.now(), data: JSON.parse(stdout.trim()) };
  } catch (err) {
    npcCid = null;
    log({ type: 'note', note: `health indisponível: ${String(err.message ?? err).slice(0, 120)}` });
    healthCache = { at: Date.now(), data: healthCache.data };
  }
  return healthCache.data;
}

// ----------------------------------------------------------------- persona
class Persona {
  constructor(def, account) {
    this.def = def;
    this.name = def.name;
    this.userId = account.userId;
    this.world = null;
    this.visit = 0;
    this.inbox = [];
    this.lastHumanChatAt = 0;
    this.lastSaidAt = 0;
    this.npc = null;
  }

  async join(scene, npc) {
    this.npc = npc;
    const world = new World(scene, {
      chat: (m) => this.onChat(m),
      appeared: (p) => { if (p.userId === this.npc.id) log({ type: 'npc_seen', persona: this.name, visit: this.visit, npc: this.npc.name, dist: +this.distanceTo().toFixed(1) }); },
      gone: (p) => { if (p.userId === this.npc.id) log({ type: 'npc_lost', persona: this.name, visit: this.visit, npc: this.npc.name }); },
      notice: (code, text) => log({ type: 'notice', persona: this.name, visit: this.visit, code, text }),
      disconnected: (code) => { if (!this.leaving) log({ type: 'disconnected', persona: this.name, visit: this.visit, code }); this.world = null; },
    });
    await world.join(signToken(this.userId, this.name, this.def.avatar));
    this.world = world;
    this.inbox = [];
    await sleep(2_500);
    const me = world.position;
    log({ type: 'join', persona: this.name, visit: this.visit, scene, room: world.roomId, npc: npc.name, pos: me && { x: +me.x.toFixed(1), z: +me.z.toFixed(1) }, humans: world.people().filter((p) => !p.npc).length });
  }

  async leave() {
    if (!this.world) return;
    const w = this.world;
    this.leaving = true;
    this.world = null;
    log({ type: 'leave', persona: this.name, visit: this.visit });
    await w.leave();
    this.leaving = false;
  }

  onChat(m) {
    const me = this.world?.position;
    const from = this.world?.people().find((p) => p.userId === m.senderId);
    const dist = me && from ? +Math.hypot(from.x - me.x, from.z - me.z).toFixed(1) : null;
    const mine = m.senderId === this.userId;
    if (!m.npc && !m.system && !mine) this.lastHumanChatAt = Date.now();
    const ev = {
      type: 'chat', persona: this.name, visit: this.visit, id: m.id, senderId: m.senderId, sender: m.senderName, npc: m.npc === true, system: m.system === true,
      text: m.text, dist, mine, toNpcDist: this.npc ? +this.distanceTo().toFixed(1) : null,
      sinceMySay: this.lastSaidAt ? +((Date.now() - this.lastSaidAt) / 1000).toFixed(1) : null,
      sinceAnyHuman: this.lastHumanChatAt ? +((Date.now() - this.lastHumanChatAt) / 1000).toFixed(1) : null,
      addressed: this.npc && m.senderId === this.npc.id ? new RegExp(`\\b${this.name}\\b`, 'i').test(m.text) : false,
    };
    if (!mine) this.inbox.push({ ...ev, at: Date.now() });
    if (!mine) log(ev);
  }

  /** Posição viva do personagem: pela sala (se a 24 m) ou pelo /health. */
  async npcLive() {
    const seen = this.world?.personAt(this.npc.id);
    if (seen) return { x: seen.x, z: seen.z, via: 'room' };
    const h = await npcPositions();
    const a = h?.[this.npc.name.toLowerCase()];
    if (a?.position) return { x: a.position.x, z: a.position.z, via: 'health', room: a.room, scene: a.scene };
    return null;
  }

  distanceTo() {
    const me = this.world?.position;
    const p = this.world?.personAt(this.npc.id);
    return me && p ? Math.hypot(p.x - me.x, p.z - me.z) : Infinity;
  }

  async say(text) {
    if (!this.world) return false;
    this.lastSaidAt = Date.now();
    const ok = this.world.say(text);
    log({ type: 'say', persona: this.name, visit: this.visit, text, ok, toNpcDist: +this.distanceTo().toFixed(1) });
    return ok;
  }

  /** Espera uma fala do personagem depois do instante `since` (ms), até `timeout`. */
  async waitReply(since, timeout = 45_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const r = this.inbox.find((m) => m.npc && m.senderId === this.npc.id && m.at >= since);
      if (r) return r;
      await sleep(400);
    }
    log({ type: 'reply_timeout', persona: this.name, visit: this.visit, waitedSec: timeout / 1000 });
    return null;
  }

  /** Chegar perto do personagem (segue-o até a faixa de 2–3 m) e ficar de frente. */
  async approach(maxMs = 120_000) {
    const end = Date.now() + maxMs;
    let leg = 0;
    while (this.world && Date.now() < end) {
      const live = await this.npcLive();
      if (!live) { await sleep(3_000); continue; }
      if (live.via === 'room') {
        this.world.walker.follow(this.world.tracker(this.npc.id));
        if (this.distanceTo() <= 3.2) { log({ type: 'near', persona: this.name, visit: this.visit, dist: +this.distanceTo().toFixed(1) }); return true; }
      } else {
        // Longe demais para ver: anda até a posição que o /health informou.
        const me = this.world.position;
        if (me && (leg++ % 6 === 0 || this.world.walker.idle)) this.world.walker.setTarget(nearestFree(this.def.scene ?? this.npc.scene, { x: live.x, z: live.z }));
      }
      await sleep(1_000);
    }
    log({ type: 'note', persona: this.name, visit: this.visit, note: `não conseguiu chegar ao ${this.npc.name} em ${Math.round(maxMs / 1000)} s (dist ${this.distanceTo().toFixed(1)})` });
    return false;
  }

  /** Ir a um ponto e esperar chegar (ou desistir). */
  async goTo(p, maxMs = 60_000) {
    if (!this.world) return false;
    const target = nearestFree(this.npc.scene, p);
    const w = this.world.walker;
    const stuck0 = w.stuckCount;
    w.setTarget(target);
    const end = Date.now() + maxMs;
    while (this.world && Date.now() < end) {
      const me = this.world.position;
      // O Walker consome o alvo ao chegar (ou ao desistir, contando em stuckCount).
      if (w.destination === null) return w.stuckCount === stuck0 && !!me && Math.hypot(me.x - target.x, me.z - target.z) < 3;
      await sleep(500);
    }
    return false;
  }

  /** Amostra de posição/distância (para "minutos a menos de 4,5 m"). */
  sample(extra = {}) {
    const me = this.world?.position;
    if (!me) return;
    log({ type: 'pos', persona: this.name, visit: this.visit, x: +me.x.toFixed(1), z: +me.z.toFixed(1), toNpc: Number.isFinite(this.distanceTo()) ? +this.distanceTo().toFixed(1) : null, ...extra });
  }
}

// ------------------------------------------------------------- roteiros
/** Fala as linhas, uma a uma, esperando a resposta (ou 45 s) e uma pausa humana. */
async function converse(p, lines, { gap = [12_000, 24_000], replyTimeout = 45_000 } = {}) {
  for (const line of lines) {
    if (!p.world) return;
    if (typeof line === 'number') { await hold(p, line); continue; }
    const at = Date.now();
    await p.say(line);
    const r = await p.waitReply(at, replyTimeout);
    if (r) log({ type: 'reply', persona: p.name, visit: p.visit, latencySec: +((r.at - at) / 1000).toFixed(1), text: r.text });
    await hold(p, rnd(gap[0], gap[1]));
  }
}

/** Fica ao lado do personagem por `ms`, amostrando a distância; segue-o se ele andar. */
async function hold(p, ms, { follow = true } = {}) {
  const end = Date.now() + ms;
  while (p.world && Date.now() < end) {
    if (follow && p.world.personAt(p.npc.id) && !p.world.walker.following) p.world.walker.follow(p.world.tracker(p.npc.id));
    if (!follow && p.world.walker.following) p.world.walker.stop();
    p.sample();
    await sleep(Math.min(5_000, end - Date.now()));
  }
}

/** Passante: chega a ~3,5 m, para um pouco, vai a outro canto, volta. */
async function passBy(p, untilMs) {
  let n = 0;
  while (p.world && Date.now() < untilMs) {
    const live = await p.npcLive();
    if (live) {
      const me = p.world.position;
      const dx = me.x - live.x, dz = me.z - live.z;
      const d = Math.hypot(dx, dz) || 1;
      const r = rnd(3.0, 4.2);
      const ang = d < 0.5 ? rnd(0, Math.PI * 2) : Math.atan2(dz, dx) + rnd(-0.6, 0.6);
      const spot = { x: live.x + Math.cos(ang) * r, z: live.z + Math.sin(ang) * r };
      const ok = await p.goTo(insideArea(p.npc.scene, spot) ? spot : { x: live.x + dx / d * r, z: live.z + dz / d * r }, 90_000);
      log({ type: 'pass', persona: p.name, visit: p.visit, n: ++n, arrived: ok, dist: +p.distanceTo().toFixed(1) });
      const pauseEnd = Math.min(untilMs, Date.now() + rnd(25_000, 40_000));
      while (p.world && Date.now() < pauseEnd) { p.sample({ phase: 'pause' }); await sleep(5_000); }
    } else {
      await sleep(5_000);
    }
    if (!p.world || Date.now() >= untilMs) break;
    // Vai a outro canto (12+ m) e fica um pouco lá.
    const me = p.world.position;
    const dest = p.world.walker.pickDestination(me);
    if (dest) {
      await p.goTo(dest, 60_000);
      const awayEnd = Math.min(untilMs, Date.now() + rnd(15_000, 25_000));
      while (p.world && Date.now() < awayEnd) { p.sample({ phase: 'away' }); await sleep(5_000); }
    }
  }
}

const SCRIPTS = {
  marina: {
    // 45 s calada ao lado antes da 1ª fala: o Nilo puxa assunto com desconhecida?
    1: async (p) => { await hold(p, 45_000); await converse(p, [
      'Nilo, oi! tudo bem? primeira vez que venho aqui',
      'eu sou fotógrafa de casamento, vim de Recife pra cá semana passada',
      'o que tem pra ver nessa praça?',
      'e você, o que tá fazendo por aqui agora?',
      'tem algum lugar bom pra sentar e ver o movimento?',
      'beleza, vou dar uma volta então. até mais, Nilo',
    ]); },
    2: async (p) => { await hold(p, 75_000); await converse(p, [
      'Nilo, oi de novo',
      'lembra de mim?',
      'e lembra o que eu faço da vida? e de onde eu vim?',
      'hoje eu tô sem câmera, só passeando. mudou alguma coisa por aqui desde a última vez?',
      'vou lá. valeu, Nilo',
    ]); },
    3: async (p, untilMs) => { await hold(p, 60_000); await converse(p, [
      'Nilo, oi. hoje tô ocupada, tô esperando uma pessoa aqui, depois a gente conversa, tá?',
    ]); log({ type: 'phase', persona: p.name, visit: p.visit, phase: 'busy_silent' }); await hold(p, Math.max(0, untilMs - Date.now()), { follow: false }); },
    4: async (p) => { await hold(p, 60_000); await converse(p, [
      'Nilo, passei só pra dar um oi, já tô indo',
      'o que você lembra de mim, assim, em uma frase?',
      'tchau!',
    ]); },
  },
  lu: {
    1: async (p) => { await hold(p, 45_000); await converse(p, [
      'Dalva, boa noite! esse bar é seu?',
      'eu toco baixo numa banda, a gente ensaia toda quinta',
      'ouvi dizer que você cantava. cantava o quê?',
      'e o que tem pra fazer nesse bairro?',
      'vou dar uma olhada no clube então. até mais, Dalva',
    ]); },
    2: async (p) => { await hold(p, 75_000); await converse(p, [
      'Dalva, oi, sou eu de novo',
      'lembra o que eu te contei da última vez?',
      'e o que você andou fazendo desde então?',
      'tá bom, vou indo',
    ]); },
    3: async (p) => { await hold(p, 60_000); await converse(p, [
      'Dalva, tudo bem? hoje passei correndo',
      'me indica um lugar pra eu ficar um pouco?',
      'valeu, vou indo. boa noite',
    ]); },
  },
  caio: {
    1: async (p) => converse(p, ['oi', 'o que é esse telão aí?']),
    2: async (p) => converse(p, ['boa noite', 'tem alguma coisa aberta por aqui?']),
  },
};

/** Roteiro de 6 h: minuto de entrada, duração, persona, personagem, modo. */
const SCHEDULE = [
  { at: 3, minutes: 15, persona: 'marina', npc: 'nilo', mode: 'talk' },
  { at: 8, minutes: 7, persona: 'tadeu', npc: 'nilo', mode: 'pass' },
  { at: 40, minutes: 15, persona: 'lu', npc: 'dalva', mode: 'talk' },
  { at: 60, minutes: 8, persona: 'caio', npc: 'nilo', mode: 'talk' },
  { at: 95, minutes: 12, persona: 'marina', npc: 'nilo', mode: 'talk' },
  { at: 130, minutes: 7, persona: 'tadeu', npc: 'nilo', mode: 'pass' },
  { at: 160, minutes: 12, persona: 'lu', npc: 'dalva', mode: 'talk' },
  { at: 185, minutes: 8, persona: 'caio', npc: 'dalva', mode: 'talk' },
  { at: 215, minutes: 14, persona: 'marina', npc: 'nilo', mode: 'talk' },
  { at: 220, minutes: 6, persona: 'caio', npc: 'nilo', mode: 'pass' },
  { at: 250, minutes: 8, persona: 'tadeu', npc: 'nilo', mode: 'pass' },
  { at: 290, minutes: 12, persona: 'lu', npc: 'dalva', mode: 'talk' },
  { at: 330, minutes: 8, persona: 'marina', npc: 'nilo', mode: 'talk' },
  { at: 340, minutes: 6, persona: 'tadeu', npc: 'nilo', mode: 'pass' },
  { at: 350, minutes: 6, persona: 'caio', npc: 'dalva', mode: 'pass' },
];
const SMOKE_SCHEDULE = [
  { at: 0, minutes: 3, persona: 'marina', npc: 'nilo', mode: 'talk', script: 1 },
  { at: 0.5, minutes: 3, persona: 'tadeu', npc: 'nilo', mode: 'pass' },
  { at: 1, minutes: 3, persona: 'lu', npc: 'dalva', mode: 'talk', script: 1 },
];

// No smoke os nomes são outros: a rodada de verdade tem de ser a PRIMEIRA vez
// que o personagem vê a Marina, a Lu, o Tadeu e o Caio.
const PERSONAS = SMOKE ? {
  marina: { name: 'Zeca', avatar: AVATARS.m1 },
  tadeu: { name: 'Bina', avatar: AVATARS.f2 },
  lu: { name: 'Tuco', avatar: AVATARS.m2 },
  caio: { name: 'Lia', avatar: AVATARS.f1 },
} : {
  marina: { name: 'Marina', avatar: AVATARS.f1 },
  tadeu: { name: 'Tadeu', avatar: AVATARS.m2 },
  lu: { name: 'Lu', avatar: AVATARS.f2 },
  caio: { name: 'Caio', avatar: AVATARS.m1 },
};

async function runVisit(p, slot) {
  const npc = NPC[slot.npc];
  p.visit++;
  const untilMs = Date.now() + slot.minutes * 60_000;
  log({ type: 'visit_start', persona: p.name, visit: p.visit, npc: npc.name, mode: slot.mode, minutes: slot.minutes });
  try {
    await p.join(npc.scene, npc);
    const h = await npcPositions();
    const a = h?.[slot.npc];
    if (a && a.room !== p.world?.roomId) log({ type: 'note', persona: p.name, visit: p.visit, note: `shard diferente do ${npc.name}: ${p.world?.roomId} vs ${a.room}` });
    if (a) log({ type: 'npc_state', persona: p.name, visit: p.visit, npc: npc.name, action: a.action, intention: a.intention, pos: a.position && { x: +a.position.x.toFixed(1), z: +a.position.z.toFixed(1) } });
    if (slot.mode === 'pass') {
      await passBy(p, untilMs);
    } else {
      const near = await p.approach();
      if (near) {
        const script = SCRIPTS[slot.persona]?.[slot.script ?? p.visit] ?? SCRIPTS[slot.persona]?.[1];
        await script(p, untilMs);
        // O resto do tempo, fica por perto (calada): é quando a iniciativa do personagem aparece.
        if (Date.now() < untilMs) { log({ type: 'phase', persona: p.name, visit: p.visit, phase: 'linger' }); await hold(p, untilMs - Date.now()); }
      }
    }
  } catch (err) {
    log({ type: 'error', persona: p.name, visit: p.visit, error: String(err?.stack ?? err).slice(0, 400) });
  } finally {
    await p.leave().catch(() => {});
    log({ type: 'visit_end', persona: p.name, visit: p.visit, npc: npc.name, mode: slot.mode, npcLines: p.inbox.filter((m) => m.npc && m.senderId === npc.id).length });
  }
}

async function main() {
  const users = JSON.parse(readFileSync(args.users, 'utf8'));
  const byName = {};
  for (const [key, def] of Object.entries(PERSONAS)) {
    const acc = users.find((u) => u.persona === key) ?? users[Object.keys(PERSONAS).indexOf(key)];
    if (!acc) throw new Error(`sem conta para ${key}`);
    byName[key] = new Persona({ ...def, scene: null }, acc);
  }
  const schedule = SMOKE ? SMOKE_SCHEDULE : SCHEDULE.filter((s) => s.at + s.minutes <= HOURS * 60 + 1);
  log({ type: 'start', stamp: STAMP, hours: HOURS, smoke: SMOKE, personas: Object.fromEntries(Object.entries(byName).map(([k, p]) => [k, { name: p.name, userId: p.userId }])), slots: schedule.length });
  const running = new Set();
  for (const slot of schedule) {
    const wait = T0 + slot.at * 60_000 - Date.now();
    if (wait > 0) await sleep(wait);
    const p = byName[slot.persona];
    if (p.world) { log({ type: 'note', persona: p.name, note: 'ainda numa visita; pulando' }); continue; }
    const task = runVisit(p, slot).finally(() => running.delete(task));
    running.add(task);
  }
  await Promise.all([...running]);
  log({ type: 'end', minutes: +((Date.now() - T0) / 60_000).toFixed(1) });
  process.exit(0);
}

process.on('SIGTERM', () => { log({ type: 'end', note: 'SIGTERM' }); process.exit(0); });
main().catch((err) => { log({ type: 'fatal', error: String(err?.stack ?? err) }); process.exit(1); });
