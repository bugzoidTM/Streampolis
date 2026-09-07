import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { matchMaker, Server } from '@colyseus/core';
import { Encoder } from '@colyseus/schema';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { config, isProduction } from './config.js';
import { CityRoom } from './rooms/CityRoom.js';
import { ApartmentRoom } from './rooms/ApartmentRoom.js';
import { LiveRoom } from './rooms/LiveRoom.js';
import type { LiveSummary } from './shared.js';
import { createScaling } from './scaling.js';
import { presence } from './world/Presence.js';
import { socialSignals } from './world/SocialSignals.js';
import { defaultApiGateway, type ModerationCommand } from './api/ApiGateway.js';

/** Um gateway por processo, para o ack das ordens de moderação. */
const api = defaultApiGateway();

/**
 * Game server process (SPECs §52, §54).
 *
 * This process synchronises world and events. It holds no permanent data and
 * settles no money — packages/api owns both. Restarting it must cost players
 * nothing but a reconnect.
 */

/**
 * Tamanho do buffer de codificação de estado. 256 KB, e não os 8 KB do padrão.
 *
 * O padrão do @colyseus/schema é `Buffer.poolSize` — 8 KB. Quando um patch não
 * cabe, o codificador AVISA e redimensiona o buffer no meio da codificação; o
 * que chega ao navegador depois disso é fluxo corrompido, e o sintoma do outro
 * lado é `"refId" not found`. O socket não cai, o servidor não erra nada no
 * log de aplicação: o jogador simplesmente passa a ver uma praça que não
 * existe.
 *
 * Por que 8 KB acabam: a praça filtra corpos por proximidade (`StateView`), e
 * uma sala com N pessoas codifica N visões no MESMO buffer compartilhado.
 * O custo cresce com o QUADRADO da lotação — com 8 pessoas nada estoura, com
 * 36 (a lotação real de um shard) estoura a cada quadro em que a maioria anda.
 * Foi assim que isto apareceu: o teste de carga com 72 jogadores gerou 72 mil
 * erros de decodificação em 60 s, e a live com 100 espectadores — que não usa
 * view nenhuma — não gerou nenhum.
 *
 * O tamanho não é chutado: o custo é `lotação × patch por visão`, ou seja
 * cresce com o QUADRADO da lotação do shard. Com 36 pessoas, medido na
 * produção, o pico pediu 72 KB — a primeira tentativa de 64 KB estourou duas
 * vezes em 3 minutos e cada estouro corrompeu o quadro de dezenas de clientes
 * (881 erros de decodificação). 256 KB é ~3,5× o pico observado: a folga existe
 * porque o modo de falha é silencioso e caro, e o preço dela é um quarto de
 * megabyte por sala.
 *
 * Tem de ser definido ANTES de qualquer sala nascer — o serializador aloca o
 * buffer dele no momento em que a sala é criada.
 *
 * Se um dia a lotação do shard subir (`CITY_CAPACITY`), este número sobe junto.
 * O sinal está no log do worker: `@colyseus/schema buffer overflow`.
 */
Encoder.BUFFER_SIZE = 256 * 1024;

export const ROOM_CITY = 'city';
export const ROOM_APARTMENT = 'apartment';
export const ROOM_LIVE = 'live';
const scaling = createScaling(config);
let accepting = false;

/**
 * Atraso do event loop, medido de dentro.
 *
 * É a única das cinco grandezas de um teste de carga que não dá para observar
 * de fora: CPU, RAM, banda e quedas o host conta sozinho, mas "o loop atrasou
 * 300 ms" só existe aqui. Importa mais que a CPU média — a simulação roda a
 * 24 Hz, e um pico de 200 ms é um tranco visível na tela de todo mundo da sala
 * enquanto a CPU ainda parece folgada.
 *
 * `resolution: 10` amostra a cada 10 ms: fino o bastante para ver um tranco,
 * grosso o bastante para o próprio medidor não pesar.
 */
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

const httpServer = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/health' || url === '/healthz' || url.startsWith('/health?')) {
    void scaling.ready().then((connected) => {
      const ok = accepting && connected;
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      /**
       * Nanossegundos → milissegundos, MENOS a resolução do amostrador.
       *
       * `monitorEventLoopDelay({resolution: 10})` mede o atraso somando o
       * intervalo de amostragem: um processo parado lê 10 ms. Descontar os 10
       * é o que faz "0" querer dizer "sem atraso" — sem isso, todo relatório
       * começa com uma dívida de 10 ms que não existe.
       */
      const ms = (ns: number) => Math.max(0, Math.round(ns / 1e5) / 10 - 10);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok, uptime: process.uptime(), env: config.env, mode: scaling.mode,
        serverId: config.serverId, processId: matchMaker.processId,
        /**
         * Números para medição, não para o jogo. São acumulados desde o boot
         * (ou desde o último `?reset=1`), o que faz deles a diferença entre
         * duas leituras — que é como se mede uma janela de carga.
         */
        metrics: {
          rssMB: Math.round(mem.rss / 1048576),
          heapUsedMB: Math.round(mem.heapUsed / 1048576),
          externalMB: Math.round(mem.external / 1048576),
          cpuUserMs: Math.round(cpu.user / 1000),
          cpuSystemMs: Math.round(cpu.system / 1000),
          loopLagMs: {
            mean: ms(loopDelay.mean), p50: ms(loopDelay.percentile(50)),
            p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max),
          },
          /** `{ roomCount, ccu }` deste processo: salas vivas e gente conectada. */
          rooms: matchMaker.stats?.local ?? null,
        },
      }));
      // Zerar o histograma é o que permite medir A JANELA em vez da vida
      // inteira do processo: um pico de ontem contaminaria a média de hoje.
      if (url.includes('reset=1')) loopDelay.reset();
    });
    return;
  }
  if (url.startsWith('/live')) {
    // PoC-only feed source. TODO(api agent): once /lives exists in the API,
    // this stays as a debug endpoint and the client stops reading it.
    listLives()
      .then((lives) => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(lives));
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'listing_failed' }));
      });
    return;
  }
  res.writeHead(404).end();
});

async function listLives(): Promise<LiveSummary[]> {
  const rooms = await matchMaker.query({ name: ROOM_LIVE });
  return rooms
    .filter((room) => room.metadata && room.metadata.ended !== true)
    .map((room) => ({
      /** Room id is the join key: watchers call joinById with it. */
      roomId: room.roomId,
      liveId: String(room.metadata.liveId ?? room.roomId),
      hostId: String(room.metadata.hostId ?? ''),
      hostName: String(room.metadata.hostName ?? ''),
      title: String(room.metadata.title ?? ''),
      category: String(room.metadata.category ?? 'geral'),
      realViewers: Number(room.metadata.realViewers ?? 0),
      isPK: room.metadata.isPK === true,
      agency: String(room.metadata.agency ?? ''),
      startedAt: Number(room.metadata.startedAt ?? 0),
    }))
    // Busiest first: the feed's default ordering (PRD §11).
    .sort((a, b) => b.realViewers - a.realViewers);
}

export const gameServer = new Server({
  ...scaling.serverOptions,
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.onBeforeShutdown(() => { accepting = false; });
gameServer.onShutdown(async () => {
  // onDispose has removed every room; publish the empty slice before exit.
  await presence().flush();
  presence().stop();
  // O acumulador social segura até 30 s de interações (§32, §26). Num
  // desligamento limpo elas não têm por que se perder — e a métrica de um dia
  // inteiro não pode depender de o processo nunca reiniciar.
  await socialSignals().flush();
  socialSignals().stop();
});

// filterBy is what shards the world: a full central-plaza-001 makes the
// matchmaker create a second plaza instead of overfilling the first (§17).
gameServer.define(ROOM_CITY, CityRoom).filterBy(['sceneId']);
gameServer.define(ROOM_APARTMENT, ApartmentRoom).filterBy(['apartmentId']);

/**
 * Lives are NOT matched by a client-supplied key.
 *
 * A host calls create(); a viewer calls joinById() with the room id the feed
 * gave them. With joinOrCreate + a filter, a manipulated client could ask to
 * "join" a live that does not exist and end up CREATING it — which is how you
 * open a broadcast in someone else's name.
 */
gameServer.define(ROOM_LIVE, LiveRoom);

/**
 * As ordens do painel administrativo (PRD §28).
 *
 * Elas chegam de carona na resposta do batimento de presença, e QUALQUER worker
 * pode recebê-las — inclusive um que não é dono da sala alvo. Quem resolve isso
 * é o `remoteRoomCall` do Colyseus, que entrega a chamada no processo dono
 * (é o mesmo mecanismo que faz `joinById` funcionar entre workers).
 *
 * Todo desfecho é confirmado de volta, inclusive o fracasso: uma ordem entregue
 * e nunca confirmada fica visível no banco, que é exatamente o que se quer
 * poder investigar quando uma live não morreu.
 */
async function executarOrdens(commands: ModerationCommand[]): Promise<void> {
  for (const ordem of commands) {
    if (ordem.command !== 'close_live') {
      await api.ackModeration(ordem.id, `desconhecida:${ordem.command}`);
      continue;
    }
    try {
      const resultado = await matchMaker.remoteRoomCall(ordem.targetId, 'moderationClose', [ordem.reason]);
      const fechou = (resultado as { closed?: boolean } | undefined)?.closed === true;
      await api.ackModeration(ordem.id, fechou ? 'closed' : 'already_ended');
    } catch (err) {
      // Sala inexistente é desfecho legítimo: a live pode ter acabado sozinha
      // entre a ordem e a entrega.
      await api.ackModeration(ordem.id, `falhou:${String((err as Error)?.message ?? err).slice(0, 120)}`);
    }
  }
}

export async function start(port = config.port, host = config.host): Promise<void> {
  await gameServer.listen(port, host);
  presence().onModeration((commands) => void executarOrdens(commands));
  accepting = true;
  console.log(`[game-server] ouvindo em ws://${host}:${port} (${config.env})`);
  if (!isProduction() && !config.authSecret) {
    console.warn('[game-server] sem AUTH_JWT_SECRET: tokens de desenvolvimento aceitos.');
  }
}

// Only auto-start when run directly — tests import the rooms without opening
// a socket.
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  start().catch((err) => {
    console.error('[game-server] falha ao subir:', err);
    process.exit(1);
  });
}
