/**
 * The home page: what Scrapy is, a way in for its owner, and a way to the docs.
 *
 * Anybody can read it. What it says about getting in depends on who may use
 * this Scrapy (lib/access.ts) and on whether this browser is logged in.
 *
 * No number on this page is typed in here. Each one is read from the running
 * Scrapy, like on the docs pages.
 */
import { PASSWORD_MIN, RELEASE } from '@/lib/config';
import { facts } from '@/lib/docs';
import { TOOLS } from '@/lib/tools';
import { OldLinks } from './ui/OldLinks';
import { viewer, type Viewer } from './ui/viewer';

export const dynamic = 'force-dynamic';

const n = (value: number): string => value.toLocaleString('en-US');

/** "Tavily", "Tavily and Exa", "Tavily, Exa and Parallel". */
function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** The way in, for the top bar and for the big button. null where there is none. */
function wayIn(who: Viewer): { href: string; label: string } | null {
  if (who.state === 'closed' || who.locked) return null;
  if (who.state === 'open' || who.loggedIn) return { href: '/dashboard', label: 'Open the dashboard' };
  return { href: '/login', label: 'Log in' };
}

/** One or two sentences under the buttons: who may use this Scrapy. */
function AccessNote({ who }: { who: Viewer }) {
  if (who.state === 'closed') {
    return (
      <p className="hero-note">
        <strong>This address is closed.</strong> Its owner has not opened it yet, so it answers no calls. The docs can be read all the same. If this is your Scrapy: give it a password with the setting <code>SCRAPY_PASSWORD</code>, and it
        answers to you alone.
      </p>
    );
  }
  if (who.locked) {
    return (
      <p className="hero-note">
        <strong>Nobody can log in right now.</strong> The password set for this Scrapy is too short. If this is your Scrapy: set one of at least {PASSWORD_MIN} characters, in the setting <code>SCRAPY_PASSWORD</code>.
      </p>
    );
  }
  if (who.state === 'open') {
    return (
      <p className="hero-note">
        This copy of Scrapy has no password, so there is nothing to log in to: whoever can open this page can use the dashboard. With a password (the setting <code>SCRAPY_PASSWORD</code>) it answers to its owner alone.
      </p>
    );
  }
  return (
    <p className="hero-note">
      <strong>This Scrapy is personal.</strong> It answers only to its owner{who.loggedIn ? ', and you are logged in' : ''}. The docs are open to everyone.
    </p>
  );
}

/** What each tool does, in a sentence for a person. The tools' own descriptions are written for an AI. */
function toolText(name: string, f: ReturnType<typeof facts>): string {
  if (name === 'search_web') {
    return `Asks several search engines, merges their lists into one, and leaves out copycat sites. Your AI gets ${n(f.search.defaultResults)} links, or up to ${n(f.search.maxResults)} when it asks for more.`;
  }
  if (name === 'fetch_url') {
    return `Loads a public page, in a real browser when the page needs one, and hands back its content as clean Markdown: no menus, no ads, no cookie banners. A long page comes in parts of about ${n(f.page.partChars)} characters.`;
  }
  return '';
}

const COMING = ['extract_text', 'extract_images', 'extract_design', 'deep_crawl', 'crawl_status'];

export default async function HomePage() {
  const who = await viewer();
  const f = facts();
  const enter = wayIn(who);
  const helpers = [...new Set([...f.search.order, ...f.page.order].map((h) => h.name))];

  return (
    <>
      <OldLinks />
      <header className="bar">
        <span className="brand">Scrapy</span>
        <span className="pill">{RELEASE}</span>
        <nav className="bar-end bar-links" aria-label="Pages">
          <a href="/docs">Docs</a>
          {enter && (
            <a className="button small" href={enter.href}>
              {who.state === 'personal' && !who.loggedIn ? 'Log in' : 'Dashboard'}
            </a>
          )}
        </nav>
      </header>

      <main className="landing">
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">Release {RELEASE}</p>
          <h1 id="hero-title">The web, for your AI.</h1>
          <p className="hero-lead">
            An AI agent cannot search the web or open a page on its own. Scrapy gives it both. The agent connects once, over MCP, and gets the tools. Scrapy is free to run and needs no account anywhere.
          </p>
          <div className="row cta">
            {enter && (
              <a className="button primary big" href={enter.href}>
                {enter.label}
              </a>
            )}
            <a className={`button big${enter ? '' : ' primary'}`} href="/docs">
              Read the docs
            </a>
          </div>
          <AccessNote who={who} />
        </section>

        <section aria-labelledby="tools-title">
          <h2 className="section-title" id="tools-title">
            What your AI gets
          </h2>
          <div className="tools">
            {TOOLS.map((tool) => (
              <div className="card" key={tool.name}>
                <div className="tool-name">{tool.name}</div>
                <h3 className="tool-title">{tool.title}</h3>
                <p>{toolText(tool.name, f)}</p>
              </div>
            ))}
          </div>
          <p className="soft">
            These {n(TOOLS.length)} tools are ready in release {RELEASE}. Coming next: {COMING.join(', ')}.
          </p>
        </section>

        <section aria-labelledby="why-title">
          <h2 className="section-title" id="why-title">
            Fast, free, smart
          </h2>
          <div className="three">
            <div>
              <h3>Fast</h3>
              <p>
                Two search engines are asked at the same moment. A page helper that is slow gets company after {n(f.page.hedgeSeconds)} seconds. Anything asked in the last {n(f.search.memoryMinutes)} minutes is answered from memory.
              </p>
            </div>
            <div>
              <h3>Free</h3>
              <p>
                {listOf(helpers)} each have a door that needs no account and no payment. Scrapy uses all {n(helpers.length)}, so it never depends on one of them.
              </p>
            </div>
            <div>
              <h3>Smart</h3>
              <p>An answer does not count because it arrived. An empty page or a block page is thrown out, and the next way is tried. Fixed rules decide this, not a second AI: they cost nothing and they are fast.</p>
            </div>
          </div>
        </section>

        <section aria-labelledby="steps-title">
          <h2 className="section-title" id="steps-title">
            How it works
          </h2>
          <ol className="steps">
            <li>
              <strong>Connect.</strong> Give your AI app Scrapy&apos;s address. The <a href="/docs">docs</a> have the lines to copy for Cursor, Claude Code, VS Code and your own code.
            </li>
            <li>
              <strong>Ask.</strong> Your AI calls a tool when it needs the web. Scrapy tells it the exact parameters, so it does not have to guess. The same rules are at <a href="/llms.txt">/llms.txt</a>.
            </li>
            <li>
              <strong>Watch.</strong> Every call shows up in the live feed on the dashboard: what was asked, which helper answered, and how long it took.
            </li>
          </ol>
        </section>

        <footer className="site-foot">
          <span>Scrapy {RELEASE}</span>
          <a href="/docs">MCP doc</a>
          <a href="/docs#docs-ai">Docs for the AI</a>
          {enter && <a href={enter.href}>{enter.label}</a>}
        </footer>
      </main>
    </>
  );
}
