import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { config } from './config.ts';
import { pool, closePool } from './db/pool.ts';
import { EconomyError } from './economy/errors.ts';
import { getBalances, listTransactions, sendGift } from './economy/EconomyService.ts';
import { loadIdentity, signSessionToken } from './auth/identity.ts';
import { assertWearable, readAvatar, saveAvatar, validateAvatar } from './profile/AvatarService.ts';
import { recordPKResult, listPKHistory } from './pk/PkRecords.ts';
import { canEnter, getHome, getOrCreateHomeOf, saveLayout, setVisibility } from './world/Homes.ts';
import { closeLive, listLives, openLive } from './world/Lives.ts';
import { optionalUser, requireService, requireUser, type AuthedRequest } from './http/middleware/auth.ts';
import { getPublicProfile, listFollowing, setFollow } from './profile/PublicProfile.ts';
import { listInventory, purchaseItem } from './shop/Purchases.ts';
import { rateLimit } from './http/middleware/rateLimit.ts';
import { cors } from './http/middleware/cors.ts';

/**
 * API REST (SPECs §51, §52).
 *
 * Fronteira: aqui vive a verdade permanente — usuários, carteira, inventário,
 * apartamentos, resultado de PK. O game server não tem credencial de banco; ele
 * conversa com estas rotas. E o navegador nunca fala com /internal.
 */

export const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');
// Atrás de um proxy o IP do cliente vem no X-Forwarded-For; sem isto o
// limitador conta todo mundo no mesmo balde (o do proxy). Configurável porque
// confiar no header quando NÃO há proxy é o contrário: qualquer um forja o IP.
app.set('trust proxy', config.trustProxy);
// Antes do limitador: um preflight recusado não deve gastar a cota de ninguém.
app.use(cors);

// Teto global do público. `/internal/*` fica de fora porque tem o seu próprio
// teto (bem mais alto) e um chamador só: somar os dois derrubaria o game server
// no meio de uma live movimentada, que é exatamente quando ele mais chama.
const generalLimit = rateLimit('general');
app.use((req, res, next) => {
  if (req.path.startsWith('/internal/') || req.path === '/health') { next(); return; }
  generalLimit(req, res, next);
});

// ---------------------------------------------------------------- saúde ---

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, env: config.isProd ? 'production' : 'development' });
  } catch {
    res.status(503).json({ ok: false, error: 'db_unavailable' });
  }
});

// ------------------------------------------------------------------ auth ---

const loginSchema = z.object({
  username: z.string().min(3).max(24),
  password: z.string().min(8).max(200),
});

app.post('/auth/login', rateLimit('auth'), async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const { rows } = await pool.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE username_lower = lower($1)',
      [body.username],
    );
    const row = rows[0];
    // Mesmo tempo e mesma resposta para "usuário não existe" e "senha errada":
    // a diferença entre as duas é um enumerador de contas.
    const hash = row?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    const ok = await bcrypt.compare(body.password, hash);
    if (!row || !ok) {
      res.status(401).json({ error: 'invalid_credentials' });
      return;
    }
    const identity = await loadIdentity(row.id);
    if (!identity) {
      res.status(403).json({ error: 'account_unavailable' });
      return;
    }
    res.json({ ...signSessionToken(identity), identity });
  } catch (err) {
    next(err);
  }
});

/**
 * Contas de demonstração, com a aparência de cada uma, para a tela de entrada
 * poder desenhar o retrato de verdade em vez de três bonecos genéricos.
 *
 * Some junto com o dev-login: se não dá para entrar sem senha, não faz sentido
 * anunciar por quem entrar.
 */
app.get('/auth/demo-accounts', async (_req, res, next) => {
  if (!config.devLogin) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    const { rows } = await pool.query<{
      username: string; display_name: string | null; config: unknown;
    }>(
      `SELECT u.username, p.display_name, av.config
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         LEFT JOIN avatars av ON av.user_id = u.id
        WHERE u.status = 'active' AND u.role = 'player'
        ORDER BY u.created_at
        LIMIT 4`,
    );
    res.json({
      accounts: rows.map((r) => ({
        username: r.username,
        displayName: r.display_name || r.username,
        avatar: r.config ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Login de desenvolvimento: entra por username, sem senha. Existe para o game
 * server e o cliente rodarem antes do cadastro existir, e some em produção
 * (config.devLogin é falso lá, sem exceção).
 */
app.post('/auth/dev-login', rateLimit('auth'), async (req, res, next) => {
  if (!config.devLogin) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    const username = z.string().min(3).max(24).parse((req.body ?? {}).username);
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM users WHERE username_lower = lower($1)',
      [username],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'user_not_found', hint: 'rode npm run seed' });
      return;
    }
    const identity = await loadIdentity(rows[0].id);
    if (!identity) {
      res.status(403).json({ error: 'account_unavailable' });
      return;
    }
    res.json({ ...signSessionToken(identity), identity });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- jogador ---

app.get('/me', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const identity = await loadIdentity(req.userId as string);
    if (!identity) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Perfil junto: a tela de perfil precisa de fama, seguidores e nível, e
    // uma segunda ida ao servidor para o próprio dono da conta é desperdício.
    const [wallet, profile, inventory, following] = await Promise.all([
      getBalances(identity.userId),
      getPublicProfile(identity.userId, identity.userId),
      listInventory(identity.userId),
      listFollowing(identity.userId),
    ]);
    res.json({ identity, wallet, profile, inventory, following });
  } catch (err) {
    next(err);
  }
});

app.get('/me/avatar', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    res.json({ avatar: await readAvatar(req.userId as string) });
  } catch (err) {
    next(err);
  }
});

/**
 * Troca de roupa. É AQUI que "vestir exige possuir" é decidido — e como o token
 * de sessão carrega a aparência assinada, é o único caminho para o game server
 * ver o jogador de roupa nova.
 */
app.put('/me/avatar', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const validation = await validateAvatar(req.userId as string, req.body);
    assertWearable(validation);
    await saveAvatar(req.userId as string, validation);
    const identity = await loadIdentity(req.userId as string);
    if (!identity) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Token novo na mesma resposta: sem isso o jogador troca de roupa e continua
    // entrando nas salas com a aparência antiga até o token expirar.
    res.json({ avatar: validation.config, rejected: validation.rejected, ...signSessionToken(identity) });
  } catch (err) {
    next(err);
  }
});

app.get('/me/home', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    res.json({ home: await getOrCreateHomeOf(req.userId as string) });
  } catch (err) {
    next(err);
  }
});

const visibilitySchema = z.object({ visibility: z.enum(['open', 'friends', 'private']) });

/**
 * A planta do apartamento. O corpo é a lista COMPLETA de peças colocadas —
 * substituir a planta inteira é mais simples de validar do que aceitar um
 * diff, e o modo de construção já tem a lista toda na mão.
 */
/**
 * A casa de OUTRA pessoa. Sem isto, visitar alguém mostrava a sala vazia (ou,
 * pior, a sua própria mobília), e "amigo veio ver meu setup" não fecha.
 *
 * A privacidade é a mesma do resto (PRD §20): `canEnter` decide, e quem não
 * pode entrar recebe 403 em vez da lista de móveis.
 */
app.get('/homes/:apartmentId', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const home = await getHome(param(req.params.apartmentId));
    if (!home) {
      res.status(404).json({ error: 'home_not_found' });
      return;
    }
    if (!(await canEnter(home, req.userId as string))) {
      res.status(403).json({ error: 'home_closed' });
      return;
    }
    res.json({ home });
  } catch (err) { next(err); }
});

app.put('/me/home/layout', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body as { placements?: unknown };
    if (!Array.isArray(body?.placements)) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const placements = body.placements.map((p) => {
      const o = p as Record<string, unknown>;
      return { itemId: String(o.itemId ?? ''), x: Number(o.x), z: Number(o.z), turn: Number(o.turn) };
    });
    const home = await getOrCreateHomeOf(req.userId as string);
    const bad = await saveLayout(req.userId as string, home.apartmentId, placements);
    if (bad) {
      res.status(422).json({ error: bad.reason, itemId: bad.itemId });
      return;
    }
    res.json({ home: await getOrCreateHomeOf(req.userId as string) });
  } catch (err) { next(err); }
});

app.put('/me/home/visibility', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const body = visibilitySchema.parse(req.body);
    const home = await getOrCreateHomeOf(req.userId as string);
    await setVisibility(req.userId as string, home.apartmentId, body.visibility);
    res.json({ apartmentId: home.apartmentId, visibility: body.visibility });
  } catch (err) {
    next(err);
  }
});

app.get('/me/wallet', rateLimit('economy'), requireUser, async (req: AuthedRequest, res, next) => {
  try {
    res.json(await getBalances(req.userId as string));
  } catch (err) {
    next(err);
  }
});

app.get('/me/ledger', rateLimit('economy'), requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    res.json(await listTransactions(req.userId as string, Number.isFinite(limit) ? limit : 50, before));
  } catch (err) {
    next(err);
  }
});

app.get('/me/pk', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    res.json({ matches: await listPKHistory(req.userId as string) });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- loja ---

app.get('/me/inventory', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    res.json({ items: await listInventory(req.userId as string) });
  } catch (err) {
    next(err);
  }
});

const purchaseSchema = z.object({
  itemId: z.string().min(2).max(64),
  currency: z.enum(['credits', 'coins']),
  // O preço NÃO vem daqui. O cliente escolhe o item e a moeda; quanto custa é
  // resposta do banco (SPECs §68 regra 6).
  idempotencyKey: z.string().min(8).max(96),
});

app.post('/me/purchases', rateLimit('economy'), requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const body = purchaseSchema.parse(req.body);
    res.json(await purchaseItem({ ...body, userId: req.userId as string }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- perfil ---

app.get('/users/:userId', optionalUser, async (req: AuthedRequest, res, next) => {
  try {
    const profile = await getPublicProfile(param(req.params.userId), req.userId);
    if (!profile) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ profile });
  } catch (err) {
    next(err);
  }
});

const followSchema = z.object({ following: z.boolean() });

app.put('/users/:userId/follow', requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const body = followSchema.parse(req.body);
    const target = param(req.params.userId);
    if (!/^[0-9a-f-]{36}$/i.test(target)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(await setFollow(req.userId as string, target, body.following));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ feed ---

app.get('/lives', async (_req, res, next) => {
  try {
    res.json({ lives: await listLives() });
  } catch (err) {
    next(err);
  }
});

/** Express 5 tipa params como string | string[]; rota com `:x` sempre dá um. */
function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

// -------------------------------------------------------------- internal ---
// Só o game server chega aqui, com o token de serviço.

const giftSchema = z.object({
  idempotencyKey: z.string().min(8).max(96),
  senderId: z.string().uuid(),
  receiverId: z.string().uuid(),
  giftId: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(999),
  liveId: z.string().uuid().nullable().optional(),
  roomId: z.string().optional(),
});

/**
 * Cobrança de presente (SPECs §26). Contrato consumido pelo HttpEconomyGateway
 * do game server: `ok:false` (ou qualquer não-2xx) significa que NENHUM evento
 * pode ser transmitido — a animação só existe se a moeda saiu.
 */
app.post('/internal/economy/gift', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    const body = giftSchema.parse(req.body);
    const result = await sendGift({
      idempotencyKey: body.idempotencyKey,
      senderId: body.senderId,
      receiverId: body.receiverId,
      giftId: body.giftId,
      quantity: body.quantity,
      liveId: body.liveId ?? null,
    });
    const identity = await loadIdentity(body.senderId);
    res.json({
      ok: true,
      transactionId: result.transaction.id,
      coinsSpent: result.coinTotal,
      creatorPoints: result.creatorPoints,
      pkPoints: result.pkPoints,
      gifterLevel: identity?.gifterLevel ?? 0,
      replay: result.replayed,
    });
  } catch (err) {
    if (err instanceof EconomyError && err.code === 'INSUFFICIENT_FUNDS') {
      res.status(402).json({ ok: false, error: err.code, message: err.message });
      return;
    }
    next(err);
  }
});

const pkResultSchema = z.object({
  battleId: z.string().min(4).max(96),
  hostA: z.string().uuid(),
  hostB: z.string().uuid(),
  scoreA: z.number().int().min(0),
  scoreB: z.number().int().min(0),
  draw: z.boolean(),
  winnerId: z.string().uuid().or(z.literal('')),
  streamId: z.string().uuid().nullable().optional(),
  startedAt: z.number().int().optional(),
  finishedAt: z.number().int(),
});

/** O game server apurou; a API grava. Não recalcula vencedor (ver PkRecords). */
app.post('/internal/pk/result', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    const body = pkResultSchema.parse(req.body);
    const record = await recordPKResult({
      battleId: body.battleId,
      hostA: body.hostA,
      hostB: body.hostB,
      scoreA: body.scoreA,
      scoreB: body.scoreB,
      draw: body.draw,
      winnerId: body.winnerId,
      streamId: body.streamId ?? null,
      startedAt: body.startedAt ? new Date(body.startedAt) : null,
      finishedAt: new Date(body.finishedAt),
    });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

app.get('/internal/homes/:apartmentId', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    const home = await getHome(param(req.params.apartmentId));
    if (!home) {
      res.status(404).json({ error: 'home_not_found' });
      return;
    }
    res.json(home);
  } catch (err) {
    next(err);
  }
});

app.get('/internal/homes/:apartmentId/can-enter/:userId', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    const home = await getHome(param(req.params.apartmentId));
    if (!home) {
      res.status(404).json({ error: 'home_not_found' });
      return;
    }
    res.json({ allowed: await canEnter(home, param(req.params.userId)) });
  } catch (err) {
    next(err);
  }
});

app.get('/internal/identity/:userId', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    const identity = await loadIdentity(param(req.params.userId));
    if (!identity) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(identity);
  } catch (err) {
    next(err);
  }
});

const openLiveSchema = z.object({
  externalId: z.string().min(4).max(96),
  hostId: z.string().uuid(),
  title: z.string().max(80),
  category: z.string().max(32),
  roomId: z.string().max(64),
});

app.post('/internal/lives', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    res.json(await openLive(openLiveSchema.parse(req.body)));
  } catch (err) {
    next(err);
  }
});

const closeLiveSchema = z.object({
  externalId: z.string().min(4).max(96),
  hostId: z.string().uuid(),
  peakViewers: z.number().int().min(0).default(0),
  uniqueViewers: z.number().int().min(0).default(0),
  likes: z.number().int().min(0).default(0),
});

app.post('/internal/lives/close', rateLimit('service'), requireService, async (req, res, next) => {
  try {
    res.json({ closed: await closeLive(closeLiveSchema.parse(req.body)) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ erros ---

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof EconomyError) {
    res.status(err.httpStatus).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid_request', issues: err.issues });
    return;
  }
  // Nada de vazar stack para o cliente; o log do processo guarda o detalhe.
  console.error('[api] erro não tratado:', err);
  res.status(500).json({ error: 'internal_error' });
});

export async function start(port = config.port, host = config.host): Promise<void> {
  await new Promise<void>((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`[api] ouvindo em http://${host}:${port}`);
      resolve();
    });
    const shutdown = () => {
      server.close(() => void closePool().then(() => process.exit(0)));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

if (process.argv[1]?.endsWith('server.ts')) {
  start().catch((err) => {
    console.error('[api] falha ao subir:', err);
    process.exit(1);
  });
}
