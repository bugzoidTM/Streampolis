import { CHAT_RATE_LIMIT, MAX_CHAT_LEN } from '../shared.js';

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
 * Baseline pt-BR profanity list. Deliberately small and stored as stems: the
 * real list belongs to the moderation service (SPECs §39/§40), this only stops
 * the obvious from reaching a room before that exists.
 * TODO(moderation): replace with the API-provided list + severity levels.
 */
const DEFAULT_TERMS = [
  'porra', 'caralho', 'merda', 'buceta', 'foder', 'fodase',
  'puta', 'viado', 'arrombado', 'cuzao', 'desgraca', 'vadia',
];

const LEET = new Map<string, string>([
  ['0', 'o'], ['1', 'i'], ['3', 'e'], ['4', 'a'], ['5', 's'], ['7', 't'], ['@', 'a'], ['$', 's'],
]);

/** Strips accents, leetspeak and repeated letters so "p0rrrra" still matches. */
function normalise(text: string): string {
  const flat = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of flat) out += LEET.get(ch) ?? ch;
  // Runs collapse to a SINGLE character, not two: "m3rrrda" has to reduce all
  // the way to "merda" or the stem never matches. The term list is normalised
  // through the same function, so a legitimate double ("carro") is compared
  // against an equally collapsed stem and nothing new starts matching.
  return out.replace(/(.)\1+/g, '$1').replace(/[^a-z0-9\s]/g, '');
}

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
