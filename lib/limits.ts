/**
 * Two brakes.
 *
 * 1. A speed limit per visitor, so one caller cannot use up everybody's share.
 * 2. A daily ceiling for Scrapy as a whole, so it cannot use up the Vercel
 *    allowance that the owner's other projects need.
 *
 * Both are deliberately simple and approximate. They are safety nets, not billing.
 */
import { limits } from './config';
import { ScrapyError, waitText } from './errors';
import { getStore, type Store } from './store';

const WINDOW_MS = 60_000;
const FLUSH_EVERY = 10;

export interface Limiter {
  /** Counts one tool call for this visitor. Throws a ScrapyError when a brake applies. */
  check(visitor: string): Promise<void>;
  usage(): { today: number; dailyCalls: number; visitorPerMinute: number };
}

function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function secondsToMidnightUtc(t: number): number {
  const d = new Date(t);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.ceil((next - t) / 1000);
}

export function createLimiter(store: Store, now: () => number = Date.now): Limiter {
  const recent = new Map<string, number[]>();
  let day = dayKey(now());
  /** Calls seen by this server today. */
  let local = 0;
  /** Calls by other servers today, as last read from the shared memory. */
  let others = 0;
  let unflushed = 0;
  let loaded = false;

  async function sync(): Promise<void> {
    const key = `calls:${day}`;
    const sharedCount = (await store.get<number>(key)) ?? 0;
    const total = Math.max(sharedCount, others) + unflushed;
    others = total - local;
    unflushed = 0;
    await store.set(key, total, 2 * 24 * 3600);
  }

  return {
    async check(visitor) {
      const t = now();
      const cfg = limits();

      if (dayKey(t) !== day) {
        day = dayKey(t);
        local = 0;
        others = 0;
        unflushed = 0;
        loaded = false;
      }
      if (!loaded) {
        loaded = true;
        others = (await store.get<number>(`calls:${day}`)) ?? 0;
      }
      if (local + others >= cfg.dailyCalls) {
        throw new ScrapyError(
          'daily_limit',
          `Scrapy has reached its daily ceiling of ${cfg.dailyCalls} calls. It starts again ${waitText(secondsToMidnightUtc(t))} (midnight UTC).`,
          secondsToMidnightUtc(t),
        );
      }

      const stamps = (recent.get(visitor) ?? []).filter((s) => t - s < WINDOW_MS);
      if (stamps.length >= cfg.visitorPerMinute) {
        recent.set(visitor, stamps);
        const oldest = stamps[0] ?? t;
        const waitSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - t) / 1000));
        throw new ScrapyError('slow_down', `Slow down: the limit is ${cfg.visitorPerMinute} calls per minute for each visitor. Try again ${waitText(waitSec)}.`, waitSec);
      }
      stamps.push(t);
      recent.set(visitor, stamps);
      if (recent.size > 5_000) {
        for (const [k, v] of recent) if (v.every((s) => t - s >= WINDOW_MS)) recent.delete(k);
      }

      local += 1;
      unflushed += 1;
      if (unflushed >= FLUSH_EVERY) await sync().catch(() => undefined);
    },

    usage() {
      const cfg = limits();
      return { today: local + others, dailyCalls: cfg.dailyCalls, visitorPerMinute: cfg.visitorPerMinute };
    },
  };
}

let defaultLimiter: Limiter | null = null;

export function getLimiter(): Limiter {
  defaultLimiter ??= createLimiter(getStore());
  return defaultLimiter;
}

/** Who is calling: the visitor's internet address as Vercel reports it. */
export function visitorOf(request: Request): string {
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return (forwarded.split(',')[0] ?? '').trim() || 'unknown';
  return 'unknown';
}
