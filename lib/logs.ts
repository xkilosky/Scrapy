/**
 * The log of tool calls, behind the "Live feed" of the check page.
 *
 * Every call that Scrapy works on is written down: when, which tool, what was
 * asked, how the answer was obtained, how long it took, and the answer itself.
 *
 * There is no database. The log lives in two places that both forget on their
 * own (see store.ts):
 * - the memory of the server that handled the call, and
 * - on Vercel, the shared memory, because there the call and the page that
 *   shows it are handled by different servers.
 *
 * What the shared memory holds:
 * - "log:list"    the last calls, without their answers
 * - "log:head"    one small value that changes when the list changes, so that
 *                 the page can ask "anything new?" every two seconds for almost nothing
 * - "log:answer:<id>"  the answer of one successful call, fetched when its card is opened
 *
 * The shared memory is a cache, not a store: it may drop things early, and two
 * servers writing at the same moment can overwrite each other. Each server
 * therefore puts its own calls back into the list every time it writes. A call
 * can still go missing from the log in a rare case. A tool call itself never
 * waits for the log and never fails because of it.
 *
 * Vercel counts every 8 KB written to or read from the shared memory against a
 * free monthly allowance. So the list and the answers are stored compressed,
 * and a burst of calls is written in one go.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { waitUntil } from '@vercel/functions';
import { LOGS, logsOn } from './config';
import { clip } from './errors';
import { sharedLayer, type SharedLayer } from './store';
import type { TraceReport } from './trace';

export interface LogStep {
  way: string;
  ok: boolean;
  ms: number;
  note: string;
}

/** 0: from memory. 1: an ordinary request. 2: read in a real browser. null: no answer was obtained. */
export type Tier = 0 | 1 | 2 | null;

export interface LogEntry {
  id: string;
  /** When the call arrived, in milliseconds since 1970. */
  at: number;
  tool: string;
  /** Who made the call: an agent over MCP, or the "Try a tool" box of the check page. */
  from: 'agent' | 'page';
  /** The question or the link, shortened. */
  input: string;
  /** The other arguments, shortened. */
  options: Record<string, string>;
  ok: boolean;
  tier: Tier;
  /** How the answer was obtained, for example "Tier 1 (Fast HTTP)". */
  method: string;
  /** The names of the ways that gave the answer, for example ["Tavily", "Exa"]. */
  by: string[];
  steps: LogStep[];
  ms: number;
  /** The length of the answer, in characters. */
  chars: number;
  /** Only for a failed call: the sentence the agent got. A successful answer is kept apart, see answer(). */
  text?: string;
}

export interface LogRead {
  /** Send this back with the next read. As long as nothing changed, "entries" is null. */
  rev: string;
  /** Oldest first. null when nothing changed since the read that returned the given rev. */
  entries: LogEntry[] | null;
}

export interface LogBook {
  /** Writes a call down. The returned promise ends when the shared memory has it; nothing needs to wait for it. */
  record(entry: LogEntry, answer: string): Promise<void>;
  read(knownRev?: string | null): Promise<LogRead>;
  /** The answer of a successful call, or null when it is no longer kept. */
  answer(id: string): Promise<string | null>;
  /**
   * Whether a caller who is over a limit should be listed now. True at most
   * once in a while for each caller, so that a caller stuck in a loop cannot
   * fill the log, or use up the shared memory's free allowance.
   */
  shouldListRefusal(caller: string): boolean;
  /** "works": written and read back. "silent": written, but it did not come back. "none": there is no shared memory here. */
  probe(): Promise<'works' | 'silent' | 'none'>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Makes a value small for the shared memory. Text like this shrinks to about a quarter. */
function pack(value: unknown): { z: string } {
  return { z: deflateRawSync(JSON.stringify(value)).toString('base64') };
}

/** The reverse of pack. A value that was not packed is handed back as it is; a damaged one counts as nothing. */
function unpack(value: unknown): unknown {
  if (!isRecord(value) || typeof value.z !== 'string') return value;
  try {
    return JSON.parse(inflateRawSync(Buffer.from(value.z, 'base64')).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** A short fingerprint of a list of entries: it changes when an entry is added or dropped. */
function revOf(entries: LogEntry[]): string {
  let h = 0x811c9dc5;
  for (const e of entries) {
    for (let i = 0; i < e.id.length; i++) h = Math.imul(h ^ e.id.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 44, 0x01000193);
  }
  return `${entries.length}-${(h >>> 0).toString(36)}`;
}

/**
 * Entries as read from the shared memory. They may have been written by an
 * older version of Scrapy, or not be entries at all, so nothing is taken on trust.
 */
function entriesFrom(value: unknown): LogEntry[] {
  const list = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  const out: LogEntry[] = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.at !== 'number' || typeof raw.tool !== 'string') continue;
    const tier: Tier = raw.tier === 0 || raw.tier === 1 || raw.tier === 2 ? raw.tier : null;
    out.push({
      id: raw.id,
      at: raw.at,
      tool: raw.tool,
      from: raw.from === 'page' ? 'page' : 'agent',
      input: typeof raw.input === 'string' ? raw.input : '',
      options: isRecord(raw.options) ? Object.fromEntries(Object.entries(raw.options).filter((kv): kv is [string, string] => typeof kv[1] === 'string')) : {},
      ok: raw.ok === true,
      tier,
      method: typeof raw.method === 'string' ? raw.method : '',
      by: Array.isArray(raw.by) ? raw.by.filter((b): b is string => typeof b === 'string') : [],
      steps: Array.isArray(raw.steps)
        ? raw.steps
            .filter(isRecord)
            .map((s) => ({ way: String(s.way ?? ''), ok: s.ok === true, ms: typeof s.ms === 'number' ? s.ms : 0, note: String(s.note ?? '') }))
        : [],
      ms: typeof raw.ms === 'number' ? raw.ms : 0,
      chars: typeof raw.chars === 'number' ? raw.chars : 0,
      ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    });
  }
  return out;
}

export interface LogBookOptions {
  /** How to reach the shared memory. Resolves to null where there is none. */
  shared?: () => Promise<SharedLayer | null>;
  /** The first part of every key in the shared memory. "log" unless a check wants a book of its own. */
  prefix?: string;
  now?: () => number;
  keep?: number;
  hours?: number;
  writeGapMs?: number;
  refusalGapMs?: number;
  maxAnswerChars?: number;
}

export function createLogBook(options: LogBookOptions = {}): LogBook {
  const layer = options.shared ?? (async () => null);
  const prefix = options.prefix ?? 'log';
  const LIST_KEY = `${prefix}:list`;
  const HEAD_KEY = `${prefix}:head`;
  const PROBE_KEY = `${prefix}:probe`;
  const answerKey = (id: string): string => `${prefix}:answer:${id}`;
  const now = options.now ?? Date.now;
  const keep = options.keep ?? LOGS.keep;
  const maxAgeMs = (options.hours ?? LOGS.hours) * 3_600_000;
  const ttlSec = Math.ceil(maxAgeMs / 1000);
  const writeGapMs = options.writeGapMs ?? LOGS.writeGapMs;
  const refusalGapMs = options.refusalGapMs ?? LOGS.refusalGapMs;
  const maxAnswerChars = options.maxAnswerChars ?? LOGS.maxAnswerChars;

  /** The calls this server handled, oldest first. */
  let own: LogEntry[] = [];
  /** Their answers. */
  const answers = new Map<string, string>();
  /** Answers that the shared memory does not have yet. */
  const unsent = new Set<string>();
  const refusals = new Map<string, number>();
  /** Counts the calls written down by this server. */
  let recorded = 0;
  /** Every call up to this count is in the shared memory. */
  let written = 0;
  /** The queue for the shared memory: one write at a time. */
  let turn: Promise<void> = Promise.resolve();
  let lastWriteAt = Number.NEGATIVE_INFINITY;

  /** Newest "keep" entries that are not too old, oldest first. Entries with the same id count once. */
  function merge(...lists: LogEntry[][]): LogEntry[] {
    const oldest = now() - maxAgeMs;
    const byId = new Map<string, LogEntry>();
    for (const list of lists) for (const e of list) if (e.at >= oldest) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(-keep);
  }

  function tidyOwn(): void {
    const kept = merge(own);
    if (kept.length === own.length) return;
    const ids = new Set(kept.map((e) => e.id));
    for (const e of own) {
      if (ids.has(e.id)) continue;
      answers.delete(e.id);
      unsent.delete(e.id);
    }
    own = kept;
  }

  async function writeOnce(): Promise<void> {
    const shared = await layer();
    if (!shared) return;
    // The answers first: a call is not listed before its answer can be opened.
    const sending = [...unsent];
    try {
      await Promise.all(
        sending.map(async (id) => {
          const answer = answers.get(id);
          if (answer !== undefined) await shared.set(answerKey(id), pack({ text: answer }), ttlSec);
          unsent.delete(id);
        }),
      );
      const before = entriesFrom(unpack(await shared.get(LIST_KEY)));
      const merged = merge(before, own);
      const rev = revOf(merged);
      await shared.set(LIST_KEY, pack({ rev, entries: merged }), ttlSec);
      await shared.set(HEAD_KEY, { rev }, ttlSec);
      // The answers of calls that just fell off the list are of no use any more.
      const listed = new Set(merged.map((e) => e.id));
      await Promise.all(before.filter((e) => e.ok && !listed.has(e.id)).map((e) => shared.delete(answerKey(e.id)).catch(() => undefined)));
    } catch {
      // The shared memory is having a bad moment. This server still has its calls, and puts them back with the next write.
    }
  }

  /**
   * One write at a time, and a pause between two writes. A write carries every
   * call recorded up to that moment, so calls that arrive close together share
   * one write: the first of them to get its turn does it, the others find
   * their call already written and are done.
   *
   * Each call waits only for its own turn. No call is kept waiting for the
   * calls that come after it, however many follow.
   */
  function writeSoon(mine: number): Promise<void> {
    const run = turn.then(async () => {
      if (written >= mine) return;
      const wait = lastWriteAt + writeGapMs - now();
      if (wait > 0) await sleep(wait);
      const upTo = recorded;
      await writeOnce();
      written = upTo;
      lastWriteAt = now();
    });
    turn = run.catch(() => undefined);
    return run;
  }

  return {
    record(entry, answer) {
      own.push(entry);
      if (entry.ok) {
        const cut = answer.length - maxAnswerChars;
        answers.set(entry.id, cut > 0 ? `${answer.slice(0, maxAnswerChars)}\n\n(Cut in the log: ${cut.toLocaleString('en-US')} more characters. The agent got all of it.)` : answer);
        unsent.add(entry.id);
      }
      tidyOwn();
      recorded += 1;
      return writeSoon(recorded);
    },

    async read(knownRev) {
      tidyOwn();
      const mine = revOf(own);
      const shared = await layer();
      let headRev = '-';
      if (shared) {
        try {
          const head = await shared.get(HEAD_KEY);
          if (isRecord(head) && typeof head.rev === 'string') headRev = head.rev;
        } catch {
          // Treated like an empty shared memory.
        }
      }
      if (knownRev && knownRev === `${headRev}.${mine}`) return { rev: knownRev, entries: null };

      let listed: LogEntry[] = [];
      let listRev = '-';
      if (shared && headRev !== '-') {
        try {
          const value = unpack(await shared.get(LIST_KEY));
          listed = entriesFrom(value);
          if (isRecord(value) && typeof value.rev === 'string') listRev = value.rev;
        } catch {
          // As above.
        }
      }
      // The rev names the list that is actually returned. If the shared memory handed out an
      // older list than its head promises, the next read sees the difference and asks again.
      return { rev: `${listRev}.${mine}`, entries: merge(listed, own) };
    },

    async answer(id) {
      const local = answers.get(id);
      if (local !== undefined) return local;
      const shared = await layer();
      if (!shared) return null;
      try {
        const found = unpack(await shared.get(answerKey(id)));
        return isRecord(found) && typeof found.text === 'string' ? found.text : null;
      } catch {
        return null;
      }
    },

    shouldListRefusal(caller) {
      const t = now();
      const last = refusals.get(caller);
      if (last !== undefined && t - last < refusalGapMs) return false;
      refusals.set(caller, t);
      if (refusals.size > 2_000) for (const [k, at] of refusals) if (t - at >= refusalGapMs) refusals.delete(k);
      return true;
    },

    async probe() {
      const shared = await layer();
      if (!shared) return 'none';
      const token = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      try {
        await shared.set(PROBE_KEY, { token }, 120);
        for (let attempt = 0; attempt < 3; attempt++) {
          const found = await shared.get(PROBE_KEY);
          if (isRecord(found) && found.token === token) return 'works';
          await sleep(250);
        }
      } catch {
        // Counts as silent.
      }
      return 'silent';
    },
  };
}

/**
 * One log book for the whole server. It hangs on globalThis because the pieces
 * of Scrapy (the MCP address, "Try a tool", the feed) may each get their own
 * copy of this file, and they must all write to and read from the same book.
 */
const HOLDER = globalThis as typeof globalThis & { __scrapyLogBook?: LogBook };

export function getLogBook(): LogBook {
  HOLDER.__scrapyLogBook ??= createLogBook({ shared: sharedLayer });
  return HOLDER.__scrapyLogBook;
}

/** For tests: start with an empty book. */
export function resetLogBook(): void {
  delete HOLDER.__scrapyLogBook;
}

let counter = 0;

/** A new id. Ids of later calls sort after ids of earlier ones. */
export function newLogId(at: number): string {
  counter = (counter + 1) % 1296;
  return `${at.toString(36).padStart(9, '0')}-${counter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 7).padEnd(5, '0')}`;
}

export function isLogId(value: string): boolean {
  return /^[0-9a-z]{9}-[0-9a-z]{7}$/.test(value);
}

/** How the answer was obtained, in the words the feed shows. */
export function methodOf(ok: boolean, trace: TraceReport): { tier: Tier; method: string; by: string[] } {
  const by = trace.route?.by ?? [];
  if (trace.cache === 'hit') return { tier: 0, method: 'Memory', by };
  if (ok && trace.route) return trace.route.browser ? { tier: 2, method: 'Tier 2 (Real browser)', by } : { tier: 1, method: 'Tier 1 (Fast HTTP)', by };
  if (ok) return { tier: null, method: 'Not recorded', by };
  // No answer. A way that was resting was not tried.
  const tried = trace.steps.filter((s) => s.ok || !s.note.startsWith('resting')).length;
  if (tried > 0) return { tier: null, method: `None worked (${tried} tried)`, by: [] };
  return { tier: null, method: 'Not started', by: [] };
}

function optionText(value: unknown): string {
  if (Array.isArray(value)) return clip(value.map((v) => String(v)).join(', '), 160);
  if (isRecord(value)) return clip(JSON.stringify(value), 160);
  return clip(String(value), 160);
}

export interface CallToLog {
  tool: string;
  rawArgs: unknown;
  from: 'agent' | 'page';
  at: number;
  ok: boolean;
  text: string;
  trace: TraceReport;
}

/** The main argument of each tool: it is what the feed shows as "Query" or "URL". */
const MAIN_ARGUMENT: Record<string, string> = { search_web: 'query', fetch_url: 'url' };

export function entryOf(call: CallToLog): LogEntry {
  const args = isRecord(call.rawArgs) ? call.rawArgs : {};
  const mainName = MAIN_ARGUMENT[call.tool];
  const main = mainName ? args[mainName] : undefined;
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries(args).slice(0, 12)) {
    if (name === mainName || value === undefined || value === null) continue;
    options[clip(name, 40)] = optionText(value);
  }
  let input: string;
  if (typeof main === 'string') input = clip(main, 300);
  else if (Object.keys(args).length === 0) input = '';
  else input = clip(JSON.stringify(args), 300);

  return {
    id: newLogId(call.at),
    at: call.at,
    tool: clip(call.tool, 60),
    from: call.from,
    input,
    options: typeof main === 'string' ? options : {},
    ok: call.ok,
    ...methodOf(call.ok, call.trace),
    steps: call.trace.steps.slice(0, 12).map((s) => ({ way: clip(s.way, 60), ok: s.ok, ms: s.ms, note: clip(s.note, 120) })),
    ms: call.trace.totalMs,
    chars: call.text.length,
    ...(call.ok ? {} : { text: clip(call.text, 600) }),
  };
}

/**
 * Writes one tool call down, if the log is on. Never throws, and returns at
 * once: the writing goes on after the answer has been sent.
 */
export function logCall(call: CallToLog, book: LogBook = getLogBook()): void {
  if (!logsOn()) return;
  try {
    const done = book.record(entryOf(call), call.text).catch(() => undefined);
    // On Vercel this keeps the server running until the log is written. Elsewhere it does nothing.
    waitUntil(done);
  } catch (err) {
    console.error('[scrapy] the call could not be written to the log', err);
  }
}
