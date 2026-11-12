/**
 * The owner: the one person a personal Scrapy answers to.
 *
 * There are no accounts and there is no database. There is one password, the
 * setting SCRAPY_PASSWORD. Two things are made from it, and neither gives the
 * password away:
 *
 * - the login of a browser. After the right password, the browser is handed a
 *   signed pass (a cookie) that is good for 30 days. The pass opens the
 *   dashboard and the addresses behind it;
 * - the key of an AI: a long text that the AI sends with every request. The
 *   key opens the MCP address, and nothing else. A key that got out cannot be
 *   used to read the log.
 *
 * Changing the password changes both. Every browser is logged out, and every
 * AI needs the new key.
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { onVercel, ownerPassword } from './config';
import { sharedLayer, type SharedLayer } from './store';

export const SESSION_COOKIE = 'scrapy_session';
export const SESSION_DAYS = 30;
const SESSION_SEC = SESSION_DAYS * 24 * 3_600;

const b64 = (bytes: Buffer): string => bytes.toString('base64url');

/**
 * The password, stretched. Everything else is made from this, not from the
 * password itself. Should a key ever leak, trying out passwords against it
 * costs a guesser this much work for every single guess.
 */
let stretched: { password: string; bytes: Buffer } | null = null;

function master(): Buffer | null {
  const password = ownerPassword();
  if (!password.usable) return null;
  if (stretched?.password !== password.value) {
    stretched = { password: password.value, bytes: scryptSync(password.value, 'scrapy owner v1', 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) };
  }
  return stretched.bytes;
}

function made(purpose: string): Buffer | null {
  const from = master();
  return from ? createHmac('sha256', from).update(purpose).digest() : null;
}

/** Compares two texts. The time it takes does not show how much of them is the same. */
function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** True for the owner's password. Never true while no usable password is set. */
export function passwordFits(typed: string): boolean {
  const password = ownerPassword();
  return password.usable && sameText(typed.trim(), password.value);
}

/** The key an AI sends. null while no usable password is set. */
export function agentKey(): string | null {
  const bytes = made('scrapy agent key v1');
  return bytes ? `scrapy_${b64(bytes).slice(0, 32)}` : null;
}

export function keyFits(key: string | null): boolean {
  const real = agentKey();
  return key !== null && real !== null && sameText(key, real);
}

/**
 * The keys a request carries. Three places are accepted, because AI apps differ
 * in what they let a person set: the header "Authorization: Bearer <key>", the
 * header "x-scrapy-key", or "?key=<key>" at the end of the address.
 */
export function keysFrom(request: Request): string[] {
  const found: string[] = [];
  const bearer = /^Bearer\s+(\S.*)$/i.exec(request.headers.get('authorization')?.trim() ?? '')?.[1]?.trim();
  if (bearer) found.push(bearer);
  const own = request.headers.get('x-scrapy-key')?.trim();
  if (own) found.push(own);
  try {
    const inAddress = new URL(request.url).searchParams.get('key')?.trim();
    if (inAddress) found.push(inAddress);
  } catch {
    // An address that cannot be read carries no key.
  }
  return found;
}

/** The first of them, or null. */
export function keyFrom(request: Request): string | null {
  return keysFrom(request)[0] ?? null;
}

/**
 * True for a request that carries the owner's key in one of the three places.
 * One right key is enough: an AI app may put something of its own into the
 * Authorization header while the owner's key sits at the end of the address.
 */
export function carriesKey(request: Request): boolean {
  return keysFrom(request).some((key) => keyFits(key));
}

/** A new pass for a browser that gave the right password. null while no usable password is set. */
export function newSession(now: number = Date.now()): string | null {
  const key = made('scrapy session v1');
  if (!key) return null;
  const body = `1.${Math.floor(now / 1000) + SESSION_SEC}.${b64(randomBytes(9))}`;
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}

/** True for a pass that Scrapy signed with the password of today, and that has not run out. */
export function sessionFits(value: string | null | undefined, now: number = Date.now()): boolean {
  if (!value || value.length > 200) return false;
  const key = made('scrapy session v1');
  if (!key) return false;
  const cut = value.lastIndexOf('.');
  const body = value.slice(0, Math.max(0, cut));
  const parts = body.split('.');
  if (parts.length !== 3 || parts[0] !== '1') return false;
  const expires = Number(parts[1]);
  if (!Number.isInteger(expires) || expires * 1000 <= now) return false;
  return sameText(value.slice(cut + 1), b64(createHmac('sha256', key).update(body).digest()));
}

export function cookieOf(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * True when the browser says that another site started this request.
 *
 * A login does not count for such a request. Otherwise a page on another site
 * could make the owner's browser run a tool or read the log. Browsers also
 * hold the cookie back in that case (SameSite=Lax): this is the second lock.
 */
export function fromAnotherSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  // An older browser: it names the page a request came from, for everything but a plain GET.
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    return true;
  }
  const here = [request.headers.get('x-forwarded-host'), request.headers.get('host')];
  try {
    here.push(new URL(request.url).host);
  } catch {
    // An address that cannot be read names no host.
  }
  return !here.includes(from);
}

/** True for a request from a browser that is logged in, made by Scrapy's own pages. */
export function loggedIn(request: Request): boolean {
  return !fromAnotherSite(request) && sessionFits(cookieOf(request, SESSION_COOKIE));
}

/**
 * For a copy of Scrapy that is shown inside a frame on another site's page, as
 * some preview tools do. Browsers keep an ordinary login cookie out of such a
 * frame. With SCRAPY_FRAMED=1 the cookie is of the kind they let in, kept apart
 * for that one outer site. The check in fromAnotherSite stays as it is.
 * Ignored on Vercel: an address there is never meant to be shown in a frame.
 */
function framed(): boolean {
  return process.env.SCRAPY_FRAMED === '1' && !onVercel();
}

function cookieRules(request: Request): string {
  if (framed()) return 'Path=/; HttpOnly; SameSite=None; Secure; Partitioned';
  return `Path=/; HttpOnly; SameSite=Lax${overHttps(request) ? '; Secure' : ''}`;
}

function overHttps(request: Request): boolean {
  if (onVercel()) return true;
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (forwarded) return forwarded === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The cookie that carries the pass. Scripts on the page cannot read it
 * (HttpOnly), other sites cannot make the browser send it along (SameSite),
 * and over https it never travels unprotected (Secure).
 */
export function sessionCookie(value: string, request: Request): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_SEC}; ${cookieRules(request)}`;
}

/** Takes the pass back: the answer to "Log out". */
export function noSessionCookie(request: Request): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${cookieRules(request)}`;
}

/** How many wrong passwords are put up with. */
export const LOGIN_LIMITS = {
  /** From one internet address, before that address has to wait. */
  perCaller: 5,
  callerMinutes: 15,
  /** From everywhere together, before the login pauses for everybody. */
  everyone: 100,
  everyoneMinutes: 60,
} as const;

interface Count {
  n: number;
  /** When the count starts again, in milliseconds since 1970. */
  until: number;
}

export interface LoginGuard {
  /**
   * Books one try for this caller, before the password is looked at. Answers
   * how many seconds the caller has to wait instead. 0 means: go on, the try
   * is booked. Every booked try must end with right() or wrong().
   */
  enter(caller: string): Promise<number>;
  /** The booked try was the right password. It is taken off again, and the caller's own count starts again. */
  right(caller: string): Promise<void>;
  /** The booked try was a wrong password. It stays counted, and the other servers are told. */
  wrong(caller: string): Promise<void>;
  /** How many seconds this caller would have to wait now. 0 means: go on. Books nothing. */
  wait(caller: string): Promise<number>;
}

/**
 * The brake on guessing the password.
 *
 * Tries are counted for each internet address, and for everybody together. The
 * second count is what stops a guesser who keeps changing address. Its price:
 * somebody who hammers the login can pause it for the owner too, for up to an
 * hour. A browser that is already logged in stays logged in, and the key of an
 * AI keeps working.
 *
 * A try is counted before its password is looked at, and without a pause in
 * between. So a thousand guesses sent in the same moment get no further than
 * a thousand sent one after another. The right password gives its try back.
 *
 * The counts are kept in this server's memory and, on Vercel, in the shared
 * memory, so that several servers count together. Between servers they are a
 * brake, not an exact counter.
 *
 * What hammering the login can cost of Vercel's shared memory is small, and
 * has a ceiling. A caller who has to wait is refused from this server's own
 * count, and nothing is read or written. Requests that arrive together share
 * one look at the shared memory. Only a wrong password that was really looked
 * at is written down (two small writes), and those stop at the limits above.
 */
export function createLoginGuard(shared: () => Promise<SharedLayer | null> = sharedLayer, now: () => number = Date.now): LoginGuard {
  const counts = new Map<string, Count>();
  /** Tries that are booked and not yet known to be right or wrong, for each caller. */
  const open = new Map<string, number>();
  const EVERYONE = 'login:all';
  const nameOf = (caller: string): string => `login:${createHash('sha256').update(caller).digest('hex').slice(0, 24)}`;
  const live = (count: unknown): Count | null => {
    const c = count as Count | null | undefined;
    return c && typeof c === 'object' && typeof c.n === 'number' && typeof c.until === 'number' && c.until > now() ? { n: c.n, until: c.until } : null;
  };
  const here = (key: string): Count | null => live(counts.get(key));
  const layer = async (): Promise<SharedLayer | null> => {
    try {
      return await shared();
    } catch {
      return null;
    }
  };

  /** The looks at the shared memory that are under way, for each count. Requests that arrive together share one. */
  const looking = new Map<string, Promise<void>>();

  /** Takes over what the other servers have counted, where that is more. A count never gets smaller this way. */
  function learn(key: string): Promise<void> {
    const underWay = looking.get(key);
    if (underWay) return underWay;
    const look = (async () => {
      let there: Count | null = null;
      try {
        there = live(await (await layer())?.get(key));
      } catch {
        // The shared memory did not answer. This server's own count still holds.
      }
      const mine = here(key);
      if (there && (!mine || there.n > mine.n)) counts.set(key, there);
      looking.delete(key);
    })();
    looking.set(key, look);
    return look;
  }

  /** Tells the other servers this server's count. */
  async function tell(key: string): Promise<void> {
    const count = here(key);
    if (!count) return;
    try {
      await (await layer())?.set(key, count, Math.max(1, Math.ceil((count.until - now()) / 1000)));
    } catch {
      // Counted here at least.
    }
  }

  function addOne(key: string, minutes: number): void {
    const before = here(key);
    if (counts.size > 2_000) for (const [k, c] of counts) if (c.until <= now()) counts.delete(k);
    counts.set(key, before ? { n: before.n + 1, until: before.until } : { n: 1, until: now() + minutes * 60_000 });
  }

  const left = (count: Count): number => Math.max(1, Math.ceil((count.until - now()) / 1000));

  /** The wait for this caller, from this server's counts as they are at this moment. */
  function waitNow(own: string): number {
    const all = here(EVERYONE);
    if (all && all.n >= LOGIN_LIMITS.everyone) return left(all);
    const mine = here(own);
    if (mine && mine.n >= LOGIN_LIMITS.perCaller) return left(mine);
    return 0;
  }

  return {
    async enter(caller) {
      const own = nameOf(caller);
      // What this server has counted itself is enough to refuse. The shared memory is not asked for a caller who has to wait.
      const already = waitNow(own);
      if (already > 0) return already;
      await learn(EVERYONE);
      await learn(own);
      // From here to the end nothing is waited for: no other request can slip in between the look and the count.
      const waitSec = waitNow(own);
      if (waitSec > 0) return waitSec;
      addOne(own, LOGIN_LIMITS.callerMinutes);
      addOne(EVERYONE, LOGIN_LIMITS.everyoneMinutes);
      open.set(own, (open.get(own) ?? 0) + 1);
      return 0;
    },
    async wrong(caller) {
      const own = nameOf(caller);
      const booked = open.get(own) ?? 0;
      if (booked > 1) open.set(own, booked - 1);
      else open.delete(own);
      await tell(own);
      await tell(EVERYONE);
    },
    async right(caller) {
      const own = nameOf(caller);
      const booked = open.get(own) ?? 0;
      if (booked > 0) {
        // The try that was booked for this request was not a wrong one.
        const all = here(EVERYONE);
        if (all && all.n > 1) counts.set(EVERYONE, { n: all.n - 1, until: all.until });
        else counts.delete(EVERYONE);
      }
      open.delete(own);
      counts.delete(own);
      try {
        await (await layer())?.delete(own);
      } catch {
        // It runs out by itself.
      }
    },
    async wait(caller) {
      const own = nameOf(caller);
      const already = waitNow(own);
      if (already > 0) return already;
      await learn(EVERYONE);
      await learn(own);
      return waitNow(own);
    },
  };
}

let defaultGuard: LoginGuard | null = null;

export function getLoginGuard(): LoginGuard {
  defaultGuard ??= createLoginGuard();
  return defaultGuard;
}

/** For tests: forget every wrong password counted so far. */
export function resetLoginGuard(): void {
  defaultGuard = null;
}
