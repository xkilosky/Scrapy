/**
 * Scrapy checks its own result before answering. A page that came back empty,
 * that only says "turn on JavaScript", or that is a block page is not an
 * answer, and the next way of loading the page is tried.
 *
 * All of this is fixed rules, not an AI. The rules only fire on short pages, so
 * a long article that happens to mention captchas is never mistaken for one.
 */
import type { FailKind } from '../errors';
import { plainText } from './markdown';

export type Verdict = { ok: true; textLength: number } | { ok: false; kind: FailKind; why: string; textLength: number };

const NEEDS_JS =
  /(enable|turn on|activate|requires?|need(s)? to enable|without) (java ?script|js)\b|java ?script (is|must be|seems to be|appears to be)?\s*(required|disabled|not enabled|turned off|needed)|doesn'?t work (properly )?without java ?script|java ?script to run this app|please enable js/i;

/** Phrases that only block pages use. */
const BLOCKED =
  /just a moment\.\.\.|checking (if the site connection is secure|your browser)|verify(ing)? (that )?you are (a )?human|are you a (robot|human)\??|unusual traffic|attention required|access (to this page has been )?denied|request (was )?blocked|you have been blocked|pardon our interruption|press (&|and) hold|(solve|complete|enter) (the|this) captcha|captcha (challenge|verification)|cf-chl|ddos protection by|error 1020|enable cookies to continue|performing security verification/i;

/** Words that a normal page can also contain. They only count on a very short page. */
const BLOCKED_WEAK = /captcha|security check|ray id:|403 forbidden|too many requests|access restricted|bot (detection|protection)/i;

const LOGIN =
  /^(sign in|log in|login|sign up)( to [^\n]{0,60})?$|(sign in|log in|login) to (continue|view|access|see|read)|you (must|need to) (be logged in|log in|sign in)|please (log in|sign in)|create an? (free )?account to (continue|read|view)|members only|this content is (for|available to) (members|subscribers)|subscribe to (continue|keep) reading|subscribers only/im;

const NOT_FOUND = /^(error )?404\b|page (was |could )?not (be )?found|^not found$|this page (does not|doesn't|could not) (exist|be found)|page you (are|were) looking for/im;

export interface JudgeInput {
  /** The page as Markdown. */
  markdown: string;
  title?: string;
}

export function judge(input: JudgeInput): Verdict {
  const text = plainText(input.markdown);
  const textLength = text.length;
  const title = (input.title ?? '').trim();
  const head = `${title}\n${text.slice(0, 600)}`;

  if (textLength < 40) return { ok: false, kind: 'empty', why: 'the page came back empty', textLength };

  if (textLength < 700 && NEEDS_JS.test(text)) {
    return { ok: false, kind: 'needs_js', why: 'the page only says "turn on JavaScript"', textLength };
  }
  if ((textLength < 1_500 && BLOCKED.test(head)) || (textLength < 400 && BLOCKED_WEAK.test(head))) {
    return { ok: false, kind: 'blocked', why: 'the site showed a block page or a "prove you are human" check', textLength };
  }
  if (textLength < 900 && NOT_FOUND.test(head)) {
    return { ok: false, kind: 'not_found', why: 'the site says the page does not exist', textLength };
  }
  if (textLength < 1_200 && LOGIN.test(head)) {
    return { ok: false, kind: 'login', why: 'the page asks for a login or a subscription', textLength };
  }
  return { ok: true, textLength };
}
