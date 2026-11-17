/**
 * Two kinds of failure.
 *
 * ScrapyError is what a tool tells the agent: a short, plain reason.
 * HelperError is what one helper service reported. The tools turn a set of
 * HelperErrors into one ScrapyError.
 */

export type Reason =
  | 'bad_input'
  | 'private_address'
  | 'not_found'
  | 'blocked'
  | 'login'
  | 'too_slow'
  | 'busy'
  | 'slow_down'
  | 'daily_limit'
  | 'not_a_page'
  | 'empty'
  | 'failed';

export class ScrapyError extends Error {
  readonly reason: Reason;
  readonly retryAfterSec: number | undefined;

  constructor(reason: Reason, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'ScrapyError';
    this.reason = reason;
    this.retryAfterSec = retryAfterSec;
  }
}

/** What a failure means, and what an agent should do after it. The rulebook for agents is made from this. */
export interface FailureAdvice {
  /** How the tool's sentence starts. An agent recognises the failure by it. */
  starts: string[];
  /** More ways the sentence can start. Rarer, and each says plainly what is wrong, so the rulebook does not list them. */
  more?: string[];
  means: string;
  /** What to do next. */
  then: string;
}

/**
 * Every reason a tool can fail for, with what to do next.
 *
 * It is keyed by Reason on purpose: a new reason does not compile until it
 * has its advice here. A test checks that every sentence a tool can answer
 * with starts the way this list says.
 */
export const FAILURES: Record<Reason, FailureAdvice> = {
  bad_input: {
    starts: ['The input for', 'This page has', 'A key name must be'],
    more: ['There is no tool called', 'No search question was given', 'The search question is too long', 'No link was given', 'This link is too long', '"', 'Scrapy reads web pages only', 'Links with a user name or password'],
    means: 'The arguments were not right. The sentence says which one and why, and lists the parameters the tool has.',
    then: 'Correct the arguments and call again. Do not send the same arguments again.',
  },
  empty: {
    starts: ['The page came back empty'],
    means: 'The page probably builds its content with JavaScript.',
    then: 'Call fetch_url again with the same url and browser set to true. If browser was already true, use another page.',
  },
  too_slow: {
    starts: ['Took too long:'],
    means: 'Nothing answered in time.',
    then: 'Call again once. If it fails again, use another page or other search words.',
  },
  failed: {
    starts: ['The free search services could not be reached', 'The free services that load pages could not be reached', 'The screenshot helper could not be reached', 'The image proxy could not be reached', 'The screenshot helper answered', 'The image helper answered', 'The screenshot helper did not return', 'The per-key allowance check could not be completed', 'Could not load this page', 'Could not crawl this site', 'GitHub answered', 'GitHub returned unreadable data', 'Something went wrong inside Scrapy'],
    means: 'A passing problem on the way to the page, or inside Scrapy.',
    then: 'Call again once, after about a minute. If it fails again, tell the user.',
  },
  slow_down: {
    starts: ['Slow down:'],
    means: 'This caller or API key has made more calls in one minute than its limit permits.',
    then: 'Wait as long as the sentence says, then call again.',
  },
  busy: {
    starts: ['The free search services are busy', 'The free services that load pages are busy', 'GitHub is busy or its free search allowance is used up'],
    means: 'The free services Scrapy relies on have had enough for now.',
    then: 'Do not call the same tool again before the time in the sentence. Work with what you already have, or tell the user.',
  },
  daily_limit: {
    starts: ['Scrapy has reached its daily ceiling', 'This key has reached its daily allowance'],
    means: 'The key or the whole Scrapy instance has reached its daily call limit.',
    then: 'Stop calling until the reset time in the sentence.',
  },
  not_found: {
    starts: ['Not found:', 'The site "'],
    means: 'The page or image link does not exist.',
    then: 'Do not call again with this link. Find a valid public page or image link.',
  },
  login: {
    starts: ['Needs a login:'],
    means: 'The page is behind a login or a subscription.',
    then: 'Do not call again with this link. Look for the same information on a public page.',
  },
  blocked: {
    starts: ['Blocked by the site:', 'Blocked by the image helper:', 'Blocked by the screenshot helper:'],
    means: 'The site or image helper refuses automated access.',
    then: 'Do not repeat this call; try another public page or image source.',
  },
  not_a_page: {
    starts: ['This link is a file', 'This link did not return a supported image'],
    means: 'The link did not return readable page content or a supported image.',
    then: 'For a page, use fetch_url. For an image, use a public PNG, JPEG, WebP or GIF link.',
  },
  private_address: {
    starts: ['Refused:'],
    means: 'The link points to a private or internal address.',
    then: 'Do not call again with this link. Scrapy only reads public web pages.',
  },
};

export type FailKind =
  /** The helper said "slow down" or "allowance used up". */
  | 'busy'
  | 'timeout'
  /** The helper could not be reached at all. */
  | 'unreachable'
  /** The helper refused this caller (for example: no access without a key from this address). */
  | 'refused'
  /** The helper answered with something Scrapy could not read. */
  | 'bad_response'
  /** The page does not exist. */
  | 'not_found'
  /** The page's site refused the helper. */
  | 'blocked'
  | 'login'
  | 'empty'
  | 'needs_js'
  | 'not_a_page'
  | 'failed'
  | 'cancelled';

export class HelperError extends Error {
  readonly helper: string;
  readonly kind: FailKind;
  readonly retryAfterSec: number | undefined;

  constructor(helper: string, kind: FailKind, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'HelperError';
    this.helper = helper;
    this.kind = kind;
    this.retryAfterSec = retryAfterSec;
  }
}

/** "in about 10 minutes", "in about 40 seconds". */
export function waitText(sec: number): string {
  if (sec <= 0) return 'in a moment';
  if (sec < 90) return `in about ${Math.max(5, Math.ceil(sec / 5) * 5)} seconds`;
  if (sec < 5_400) return `in about ${Math.ceil(sec / 60)} minutes`;
  return `in about ${Math.ceil(sec / 3_600)} hours`;
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** One helper's failure in plain words, for the lists of what was tried. */
export function describeFailure(error: HelperError): string {
  switch (error.kind) {
    case 'busy':
      return `busy (${error.message})`;
    case 'unreachable':
      return `could not be reached (${error.message})`;
    case 'refused':
      return `refused this caller (${error.message})`;
    case 'bad_response':
      return `answered with something unreadable (${error.message})`;
    case 'cancelled':
      return 'stopped, another way answered first';
    default:
      return error.message;
  }
}
