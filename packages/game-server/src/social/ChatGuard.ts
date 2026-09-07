import { CHAT_RATE_LIMIT, DEFAULT_TERMS, MAX_CHAT_LEN, normaliseText } from '../shared.js';

export type ChatRejectReason =
  | 'empty'
  | 'too_long'
  | 'rate_limited'
  | 'duplicate'
  | 'muted'
  | 'blocked';

export type ChatVerdict =
  | { ok: true; text: string; filtered: boolean }
  | { ok: false; reason: ChatRejectReason; message: string };

/**
 * A lista e a normalização MUDARAM DE CASA: agora moram em `shared/moderation`,
 * porque o §27 também pede moderação de username e de título de live — e essas
 * duas acontecem na API. Duas listas seriam pior do que uma incompleta: a
 * palavra proibida no chat e permitida no nome do perfil ensina exatamente onde
 * escrever o que não se pode.
 *
 * O comportamento do chat não muda: os mesmos radicais, a mesma normalização.
 */
const normalise = normaliseText;

export interface ChatGuardOptions {
  terms?: string[];
  now?: () => number;
}

interface Bucket {
  stamps: number[];
  lastText: string;
  lastAt: number;
}

/**
 * Server-side chat gate (SPECs §31). The room asks this before broadcasting;
 * nothing reaches other clients that has not passed through here.
 */
export class ChatGuard {
  private readonly buckets = new Map<string, Bucket>();
  private readonly muted = new Map<string, number>();
  /** viewerId -> set of senderIds that viewer refuses to see. */
  private readonly blocks = new Map<string, Set<string>>();
  private readonly terms: string[];
  private readonly now: () => number;

  constructor(opts: ChatGuardOptions = {}) {
    this.terms = (opts.terms ?? DEFAULT_TERMS).map((t) => normalise(t)).filter(Boolean);
    this.now = opts.now ?? Date.now;
  }

  mute(userId: string, durationMs: number): void {
    this.muted.set(userId, this.now() + durationMs);
  }

  unmute(userId: string): void {
    this.muted.delete(userId);
  }

  isMuted(userId: string): boolean {
    const until = this.muted.get(userId);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.muted.delete(userId);
      return false;
    }
    return true;
  }

  block(viewerId: string, targetId: string): void {
    let set = this.blocks.get(viewerId);
    if (!set) this.blocks.set(viewerId, (set = new Set()));
    set.add(targetId);
  }

  unblock(viewerId: string, targetId: string): void {
    this.blocks.get(viewerId)?.delete(targetId);
  }

  /** Used by the room to skip delivery per recipient, not to reject the sender. */
  blocksSender(viewerId: string, senderId: string): boolean {
    return this.blocks.get(viewerId)?.has(senderId) === true;
  }

  forget(userId: string): void {
    this.buckets.delete(userId);
    this.blocks.delete(userId);
  }

  /**
   * Full check: mute, length, rate, duplicate-spam, profanity. Returns the text
   * to broadcast (already masked) or the reason to refuse.
   */
  check(userId: string, rawText: unknown): ChatVerdict {
    if (this.isMuted(userId)) {
      return { ok: false, reason: 'muted', message: 'Você está silenciado nesta sala.' };
    }

    const text = typeof rawText === 'string' ? rawText.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { ok: false, reason: 'empty', message: 'Mensagem vazia.' };
    if (text.length > MAX_CHAT_LEN) {
      return { ok: false, reason: 'too_long', message: `Máximo de ${MAX_CHAT_LEN} caracteres.` };
    }

    const t = this.now();
    let bucket = this.buckets.get(userId);
    if (!bucket) this.buckets.set(userId, (bucket = { stamps: [], lastText: '', lastAt: 0 }));

    const windowStart = t - CHAT_RATE_LIMIT.windowMs;
    // Filter in place-ish: the window is 5 entries, an array rebuild is cheaper
    // than a ring buffer and impossible to get wrong.
    bucket.stamps = bucket.stamps.filter((s) => s > windowStart);
    if (bucket.stamps.length >= CHAT_RATE_LIMIT.messages) {
      return { ok: false, reason: 'rate_limited', message: 'Devagar — muitas mensagens seguidas.' };
    }

    if (bucket.lastText === text && t - bucket.lastAt < CHAT_RATE_LIMIT.windowMs) {
      // Counts against the rate window too, otherwise a spammer alternates two
      // strings and never trips anything.
      bucket.stamps.push(t);
      return { ok: false, reason: 'duplicate', message: 'Mensagem repetida.' };
    }

    bucket.stamps.push(t);
    bucket.lastText = text;
    bucket.lastAt = t;

    const masked = this.mask(text);
    return { ok: true, text: masked.text, filtered: masked.filtered };
  }

  /** Replaces matched stems with asterisks, keeping the sentence readable. */
  mask(text: string): { text: string; filtered: boolean } {
    let filtered = false;
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      const norm = normalise(word);
      if (!norm) continue;
      if (this.terms.some((term) => norm.includes(term))) {
        words[i] = '*'.repeat(Math.max(3, Math.min(word.length, 8)));
        filtered = true;
      }
    }
    return { text: words.join(' '), filtered };
  }
}
