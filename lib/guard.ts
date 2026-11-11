/**
 * Decides which links Scrapy accepts.
 *
 * Scrapy reads public web pages only. Links to private or internal addresses
 * are refused, so nobody can use Scrapy to look inside a private network.
 */
import { lookup } from 'node:dns/promises';
import { ScrapyError } from './errors';

/** An IPv4 address as one number, or null when the text is not one. */
export function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** An IPv6 address as eight 16-bit groups, or null when the text is not one. */
export function parseIPv6(text: string): number[] | null {
  let s = text.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(':')) return null;

  // An IPv4 tail such as ::ffff:10.0.0.1 becomes two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === '') return [];
    const groups: number[] = [];
    for (const g of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = parse(halves[1] ?? '');
  if (rest === null) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

const V4_BLOCKED: [number, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => [parseIPv4(base as string) as number, bits as number]);

function v4Private(value: number): boolean {
  for (const [base, bits] of V4_BLOCKED) {
    const size = 2 ** (32 - bits);
    if (value >= base && value < base + size) return true;
  }
  return false;
}

function v6Private(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const v4Tail = g6 * 65536 + g7;
  const headZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (headZero && g5 === 0) return g6 === 0 && g7 <= 1 ? true : v4Private(v4Tail); // ::, ::1, ::a.b.c.d
  if (headZero && g5 === 0xffff) return v4Private(v4Tail); // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4Private(v4Tail); // NAT64
  if (g0 === 0x2002) return v4Private(g1 * 65536 + g2); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (old)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  return false;
}

/** True for an address that is not on the public internet. Unreadable text counts as private. */
export function isPrivateIp(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return v4Private(v4);
  const v6 = parseIPv6(address);
  if (v6 !== null) return v6Private(v6);
  return true;
}

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.home.arpa', '.test', '.invalid', '.onion', '.localdomain'];

/** True for a host name that can only mean a private or internal machine. */
export function isPrivateHostname(hostname: string): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return true;
  if (host.startsWith('[')) return isPrivateIp(host);
  if (parseIPv4(host) !== null) return isPrivateIp(host);
  if (host === 'localhost') return true;
  if (!host.includes('.')) return true; // "intranet", "router", "instance-data"
  if (/^[0-9.]+$/.test(host)) return true; // digits and dots that are not a valid address
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Checks a link given to a tool. Returns it tidied up, or throws a ScrapyError
 * with a plain reason.
 */
export function checkPublicUrl(input: string): URL {
  let raw = (input ?? '').trim();
  if (raw === '') throw new ScrapyError('bad_input', 'No link was given.');
  if (raw.length > 2_000) throw new ScrapyError('bad_input', 'This link is too long (more than 2,000 characters).');
  // Agents often leave the "https://" off.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[\w.-]+:\d+(\/|$)/.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ScrapyError('bad_input', `"${input.slice(0, 120)}" is not a web link. A link looks like https://example.com/page.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScrapyError('bad_input', `Scrapy reads web pages only (http and https), not "${url.protocol}" links.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ScrapyError('bad_input', 'Links with a user name or password inside them are not accepted.');
  }
  if (isPrivateHostname(url.hostname)) {
    throw new ScrapyError('private_address', `Refused: "${url.hostname}" is a private or internal address. Scrapy only reads public web pages.`);
  }
  // A plain "#section" is dropped. "#/route" and "#!route" are kept: some sites use them as page addresses.
  if (url.hash !== '' && !url.hash.startsWith('#/') && !url.hash.startsWith('#!')) url.hash = '';
  return url;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) => {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map((a) => a.address);
};

/**
 * For Scrapy's own downloads only: looks the host name up and refuses it when
 * any of its addresses is private. Returns the addresses, so the download can
 * be tied to exactly these.
 */
export async function resolvePublicHost(hostname: string, resolver: Resolver = systemResolver): Promise<string[]> {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (parseIPv4(host) !== null || parseIPv6(host) !== null) {
    if (isPrivateIp(host)) throw new ScrapyError('private_address', `Refused: "${hostname}" is a private or internal address.`);
    return [host];
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    throw new ScrapyError('not_found', `The site "${hostname}" does not exist (its name could not be looked up).`);
  }
  if (addresses.length === 0) throw new ScrapyError('not_found', `The site "${hostname}" does not exist (its name could not be looked up).`);
  if (addresses.some(isPrivateIp)) {
    throw new ScrapyError('private_address', `Refused: "${hostname}" points to a private or internal address.`);
  }
  return addresses;
}
