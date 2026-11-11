/**
 * Scrapy's short memory. There is no database.
 *
 * Two layers: the memory of the running server, and on Vercel the "Runtime
 * Cache", which is shared between servers. Both forget on their own. If the
 * shared layer is unavailable, Scrapy carries on with its own memory.
 */
import { onVercel } from './config';

export interface Store {
  get<T>(key: string): Promise<T | null>;
  /** local: true keeps the value out of the shared layer. */
  set(key: string, value: unknown, ttlSec: number, opts?: { local?: boolean }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Entry {
  value: unknown;
  expires: number;
}

const MAX_ENTRIES = 400;
const MAX_SHARED_CHARS = 1_200_000;

export function createMemoryStore(now: () => number = Date.now): Store {
  const entries = new Map<string, Entry>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expires <= now()) {
        entries.delete(key);
        return null;
      }
      return hit.value as T;
    },
    async set(key, value, ttlSec) {
      if (entries.size >= MAX_ENTRIES && !entries.has(key)) {
        const t = now();
        for (const [k, e] of entries) if (e.expires <= t) entries.delete(k);
        // Still full: drop the oldest entries. A Map keeps insertion order.
        while (entries.size >= MAX_ENTRIES) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          entries.delete(oldest.value);
        }
      }
      entries.delete(key);
      entries.set(key, { value, expires: now() + ttlSec * 1000 });
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

interface SharedCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

let sharedPromise: Promise<SharedCache | null> | null = null;
let sharedBrokenUntil = 0;

async function shared(): Promise<SharedCache | null> {
  if (!onVercel() || process.env.SCRAPY_SHARED_CACHE === 'off') return null;
  if (Date.now() < sharedBrokenUntil) return null;
  sharedPromise ??= import('@vercel/functions')
    .then((mod) => mod.getCache({ namespace: 'scrapy' }) as SharedCache)
    .catch(() => null);
  return sharedPromise;
}

function sharedFailed(): void {
  // Leave the shared layer alone for 5 minutes, then try again.
  sharedBrokenUntil = Date.now() + 300_000;
}

interface SharedEnvelope {
  v: unknown;
  /** When the value stops being valid, in milliseconds since 1970. */
  e: number;
}

/** Memory first, then the shared layer. */
export function createLayeredStore(): Store {
  const memory = createMemoryStore();
  return {
    async get<T>(key: string): Promise<T | null> {
      const local = await memory.get<T>(key);
      if (local !== null) return local;
      const cache = await shared();
      if (!cache) return null;
      try {
        const found = (await cache.get(key)) as SharedEnvelope | null | undefined;
        if (!found || typeof found !== 'object' || typeof found.e !== 'number') return null;
        const leftSec = Math.floor((found.e - Date.now()) / 1000);
        if (leftSec <= 0) return null;
        await memory.set(key, found.v, leftSec);
        return found.v as T;
      } catch {
        sharedFailed();
        return null;
      }
    },
    async set(key, value, ttlSec, opts) {
      await memory.set(key, value, ttlSec);
      if (opts?.local) return;
      const cache = await shared();
      if (!cache) return;
      try {
        const envelope: SharedEnvelope = { v: value, e: Date.now() + ttlSec * 1000 };
        if (JSON.stringify(envelope).length > MAX_SHARED_CHARS) return;
        await cache.set(key, envelope, { ttl: ttlSec });
      } catch {
        sharedFailed();
      }
    },
    async delete(key) {
      await memory.delete(key);
      const cache = await shared();
      if (!cache) return;
      try {
        await cache.delete(key);
      } catch {
        sharedFailed();
      }
    },
  };
}

let defaultStore: Store | null = null;

export function getStore(): Store {
  defaultStore ??= createLayeredStore();
  return defaultStore;
}

/** A short, stable key for anything that can be turned into JSON. */
export function keyOf(prefix: string, value: unknown): string {
  const text = JSON.stringify(value);
  // FNV-1a, twice with different seeds: 64 bits, plenty for a cache key.
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
  }
  return `${prefix}:${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}:${text.length}`;
}
