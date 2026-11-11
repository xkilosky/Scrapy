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
