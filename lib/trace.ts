/**
 * A record of what one tool call did: every address it contacted, every way it
 * tried and how long each took. The dashboard shows it, and it is how the
 * "safe position" promise can be verified.
 */

export interface Contact {
  /** Why the request was made, for example "tavily search". */
  purpose: string;
  method: string;
  /** Address without the query string. */
  address: string;
  host: string;
  /** HTTP status, or null when no answer arrived. */
  status: number | null;
  ms: number;
  note?: string;
}

export interface Step {
  way: string;
  ok: boolean;
  ms: number;
  note: string;
}

/** How an answer was obtained: which ways gave it, and whether a real browser read the page. */
export interface Route {
  /** Names of the ways that answered, for example ["Tavily", "Exa"]. */
  by: string[];
  browser: boolean;
}

export interface TraceReport {
  totalMs: number;
  cache: 'hit' | 'miss' | 'off';
  /** null when no answer was obtained. */
  route: Route | null;
  steps: Step[];
  contacts: Contact[];
  hosts: string[];
  samples?: { who: string; text: string }[];
}

export class Trace {
  readonly startedAt = Date.now();
  readonly contacts: Contact[] = [];
  readonly steps: Step[] = [];
  readonly samples: { who: string; text: string }[] = [];
  cache: 'hit' | 'miss' | 'off' = 'off';
  route: Route | null = null;

  /** With debug on, helpers keep the start of their raw answers. Used by the checks only. */
  constructor(readonly debug = false) {}

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  step(way: string, ok: boolean, ms: number, note: string): void {
    this.steps.push({ way, ok, ms, note });
  }

  /** The tools call this once they have an answer: who gave it, and whether a real browser read the page. */
  via(by: string[], browser: boolean): void {
    this.route = { by, browser };
  }

  sample(who: string, text: string): void {
    if (this.debug) this.samples.push({ who, text: text.slice(0, 700) });
  }

  hosts(): string[] {
    return [...new Set(this.contacts.map((c) => c.host))].sort();
  }

  report(): TraceReport {
    return {
      totalMs: this.elapsed(),
      cache: this.cache,
      route: this.route,
      steps: this.steps,
      contacts: this.contacts,
      hosts: this.hosts(),
      ...(this.debug ? { samples: this.samples } : {}),
    };
  }
}
