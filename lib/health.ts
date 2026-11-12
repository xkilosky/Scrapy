/**
 * Keeps track of which helpers are answering.
 *
 * A helper that says "slow down" is rested for as long as it asked, and the
 * others carry on. A helper that fails twice in a row gets a short rest.
 */
import { REST } from './config';
import { getStore, type Store } from './store';

export interface HelperState {
  /** Seconds until the helper is used again. 0 means it is in use. */
  restingSec: number;
  fails: number;
  /** Typical answer time, or null before the first answer. */
  avgMs: number | null;
  note: string;
}

interface Slot {
  restUntil: number;
  fails: number;
  avgMs: number | null;
  note: string;
  sharedCheckedAt: number;
}

const SHARED_CHECK_EVERY_MS = 60_000;

export interface Health {
  /** Seconds this helper still has to rest. 0 means it can be used. */
  resting(id: string): Promise<number>;
  rest(id: string, sec: number, why: string): Promise<void>;
  succeeded(id: string, ms: number): void;
  failed(id: string, why: string): Promise<void>;
  snapshot(): Record<string, HelperState>;
}

export function createHealth(store: Store, now: () => number = Date.now): Health {
  const slots = new Map<string, Slot>();

  function slot(id: string): Slot {
    let s = slots.get(id);
    if (!s) {
      s = { restUntil: 0, fails: 0, avgMs: null, note: '', sharedCheckedAt: 0 };
      slots.set(id, s);
    }
    return s;
  }

  return {
    async resting(id) {
      const s = slot(id);
      if (s.restUntil <= now() && now() - s.sharedCheckedAt > SHARED_CHECK_EVERY_MS) {
        // Another server may have been told "slow down" for this helper.
        s.sharedCheckedAt = now();
        const until = await store.get<{ until: number; why: string }>(`rest:${id}`);
        if (until && until.until > now()) {
          s.restUntil = until.until;
          s.note = until.why;
        }
      }
      return s.restUntil > now() ? Math.ceil((s.restUntil - now()) / 1000) : 0;
    },

    async rest(id, sec, why) {
      const s = slot(id);
      const seconds = Math.max(5, Math.min(sec, 24 * 3600));
      s.restUntil = now() + seconds * 1000;
      s.note = why;
      s.fails = 0;
      await store.set(`rest:${id}`, { until: s.restUntil, why }, seconds);
    },

    succeeded(id, ms) {
      const s = slot(id);
      s.fails = 0;
      s.note = '';
      s.avgMs = s.avgMs === null ? ms : Math.round(s.avgMs * 0.7 + ms * 0.3);
    },

    async failed(id, why) {
      const s = slot(id);
      s.fails += 1;
      s.note = why;
      if (s.fails >= REST.failsBeforeRest) {
        s.restUntil = now() + REST.failSec * 1000;
        s.fails = 0;
        // A short rest stays in this server's memory. It is not worth a shared write.
      }
    },

    snapshot() {
      const out: Record<string, HelperState> = {};
      for (const [id, s] of slots) {
        out[id] = {
          restingSec: s.restUntil > now() ? Math.ceil((s.restUntil - now()) / 1000) : 0,
          fails: s.fails,
          avgMs: s.avgMs,
          note: s.note,
        };
      }
      return out;
    },
  };
}

let defaultHealth: Health | null = null;

export function getHealth(): Health {
  defaultHealth ??= createHealth(getStore());
  return defaultHealth;
}
