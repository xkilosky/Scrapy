# Scrapy

Web tools for AI agents. An agent connects once, over MCP, and can then search the web and read pages. Scrapy is free to run and needs no account and no paid key anywhere.

People do not use Scrapy directly. An AI agent does, for example to find out how to fix a bug or to read a documentation page.

Scrapy is **personal**: give it one password of your own and it answers only to you. There are no users and no accounts. See [Personal, open or closed](#personal-open-or-closed).

**Status:** release G - 1.0 (version 1.0.0). `search_web` and `fetch_url` work. Scrapy has a home page, a login, a dashboard and docs. The full plan is in [PLAN.md](PLAN.md).

## The tools

| Tool | What the agent sends | What it gets back | Status |
| --- | --- | --- | --- |
| `search_web` | A question. Optionally: how many results, sites to include or leave out, how recent. | A list of the best links, each with title, link and short description. Duplicates and copycat sites are removed. | Ready |
| `fetch_url` | A link. Optionally: Markdown or HTML, a focus such as "rate limits", a part number, "use a real browser". | The page's main content only: no menus, ads, pop-ups or cookie banners. Long pages come in numbered parts. | Ready |
| `extract_text` | A link. | The visible text, grouped by where it sits on the page. | Stage 2 |
| `extract_images` | A link. | Every image with its address, description and kind. | Stage 2 |
| `extract_design` | A link. | Colour codes with their use, fonts, text sizes, button styles. | Stage 2 |
| `deep_crawl` | A start link, a depth, an optional folder, a page limit. | The text of the pages, or a job number for a big crawl. | Stage 3 |
| `crawl_status` | The job number. | Progress, then the pages. | Stage 3 |

When a tool cannot do its job, it answers with one plain sentence that says why: "Not found", "Needs a login", "Blocked by the site", "Took too long", or "The free services are busy. Try again in about 10 minutes."

A tool accepts exactly the parameters it lists. An agent that makes one up gets it back at once, with the real ones next to it:

```text
The input for search_web is not right. It has no parameter "q" or "limit". Parameters of search_web: query (string, required, 1 to 500 characters); max_results (integer, 1 to 20, default 8); ...
```

Only the form of a value is forgiven, where it can mean one thing only: a number or true/false written as text, one item where a list is expected, and null or an empty text for a parameter that is not used. The exact parameters, with examples, are on the page [Docs, For the AI](#the-docs).

## Connecting an agent

Scrapy has one address: `https://<where Scrapy runs>/api/mcp`. It speaks MCP over Streamable HTTP.

For an agent that takes a configuration file:

```json
{
  "mcpServers": {
    "scrapy": { "url": "https://<where Scrapy runs>/api/mcp" }
  }
}
```

For an agent that only supports local MCP servers:

```json
{
  "mcpServers": {
    "scrapy": { "command": "npx", "args": ["-y", "mcp-remote", "https://<where Scrapy runs>/api/mcp"] }
  }
}
```

A personal Scrapy also wants its owner's key with every request, in the header `Authorization: Bearer <key>`:

```json
{
  "mcpServers": {
    "scrapy": {
      "url": "https://<where Scrapy runs>/api/mcp",
      "headers": { "Authorization": "Bearer <your key>" }
    }
  }
}
```

The key is on the dashboard, under "The address for your agent". An app with no place for a header can send it as the header `x-scrapy-key`, or carry it at the end of the address: `/api/mcp?key=<your key>`. A request without the key gets one sentence that says so.

Scrapy's docs have all of this ready to copy, with the real address filled in, for Cursor, Claude Code, VS Code, local-only apps and your own code: `/docs`, or in the dashboard's menu, Docs, MCP doc. For the owner, logged in, the copy buttons fill in the real key.

A Vercel test address is behind Vercel's login, and an agent cannot log in. To let one in, create a secret in the Vercel project (Settings, Deployment Protection, "Protection Bypass for Automation") and have the agent send it with every request in the header `x-vercel-protection-bypass`. At a test address the MCP doc adds that header to every example.

## How it works

**No keys.** Scrapy uses free services that officially offer a door with no key: Tavily, Firecrawl, Exa, Parallel and Jina Reader. This README calls them helpers. Their free allowances are small and not published, so Scrapy keeps several for each job.

**Search.** Two search engines are asked at the same time (Tavily and Exa, the two fastest when measured) and their results are merged. A page that both found is listed once and ranked first. Results from copycat sites are removed, and no more than three results come from one site. If the first two engines fail or find too little, the other two (Parallel and Firecrawl) are asked.

**Reading a page.** Scrapy tries the ways of loading a page in order and checks each result itself. A page that came back empty, that only says "turn on JavaScript", or that is a block page is not an answer, and the next way is tried. A page with very little text may only be the frame of a page that builds its content with JavaScript, so it is read once more in a real browser and the fuller result is kept. When a way is slow, the next one is started alongside and the first good answer wins. Scrapy remembers which way worked for a site, and whether the site needed a real browser.

**Resting.** A helper that says "slow down" is left alone for as long as it asked, and the others carry on.

**Memory.** Every page and every search is remembered for 15 minutes, so asking twice asks no helper twice. There is no database.

**Rules, not AI.** What counts as "clean", as a duplicate or as a copycat site is decided by fixed rules. They cost nothing, they are fast, and the same input always gives the same output.

## The three positions

One setting, `SCRAPY_MODE`, decides how pages get loaded.

| Position | What Scrapy does | Good to know |
| --- | --- | --- |
| `safe` (the default) | Only asks the helpers. It never downloads a page itself. | Every tool can answer "busy" when the helpers' free allowances run out. |
| `middle` | Helpers first. Downloads a page itself only when they are busy. | |
| `full` | Downloads pages itself first. Helpers only for pages that need a real browser. | Fastest, with no daily cap on ordinary pages. |

Before choosing `middle` or `full` on Vercel, read Vercel's [fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines). They list "Scrapers" under "Never fair use", on every plan. A Scrapy that downloads pages itself is what that rule names. In the `safe` position Scrapy only calls other services' APIs, which the same guidelines list as fair use.

"Run checks" shows every address Scrapy contacted, so the safe position can be verified instead of trusted.

## Personal, open or closed

Who may use a Scrapy depends on one setting, `SCRAPY_PASSWORD`.

| State | When | Who may use it |
| --- | --- | --- |
| **Personal** | A password is set. | Its owner alone, at every address. |
| **Open** | No password, on your own machine or on one of Vercel's test addresses. Or no password and `SCRAPY_OPEN=1`. | Everybody who gets to the address. |
| **Closed** | No password, on Vercel's public address. | Nobody. Every call is answered with one sentence, and nobody is contacted. |

So a Scrapy that was just put on Vercel is closed until its owner decides. Nobody can find the address and use up the free allowances first. In every state, anybody can read the home page and the docs: they hold no secret.

**Making it personal.** Set `SCRAPY_PASSWORD` to a password of at least 10 characters, and deploy again. On Vercel: the project's Settings, Environment Variables. Choose one that cannot be guessed: several unrelated words, or a long random text. There is one owner, so there is no user name, no sign-up and no database. Two things are made from the password, and neither gives it away:

- **The login of a browser.** `/login` asks for the password. After the right one, the browser holds a pass (a cookie) for 30 days. The pass opens the dashboard and what is behind it: the checks, "Try a tool" and the live feed. "Log out" is at the foot of the dashboard's menu.
- **The key of an AI.** A long text that starts with `scrapy_`, shown on the dashboard. The AI sends it with every request. The key opens the MCP address and nothing else: a key that got out cannot read the log.

Good to know:

- **A new password changes both.** Every browser is logged out and every AI needs the new key. That is also how to take a key back.
- **A password shorter than 10 characters lets nobody in.** A short password can be guessed. The login page then says what is wrong.
- **Guessing is slowed down.** After 5 wrong passwords from one internet address, that address waits 15 minutes. After 100 wrong passwords from everywhere, the login pauses for an hour for everybody, the owner included. Guesses sent in the same moment are counted like guesses sent one after another. A browser that is already logged in stays logged in, and the key keeps working.
- **Logging in from another site's page does not work**, and a page on another site cannot use the owner's login.
- Scrapy keeps the password nowhere but in that setting. Nothing about it is stored, and nothing but the setting can reset it.

Vercel's test addresses need your Vercel login before anything reaches Scrapy. With a password they are personal like every other address.

Good to know: Vercel makes the very first deployment of a new project the public one, whichever branch it comes from.

## Settings

All settings are optional environment variables. One of them is a secret of your own, the password. None is a key or an account at another service. They are listed with explanations in [.env.example](.env.example): the password, the position, the order of the helpers, helpers to switch off, the two limits, and the log of tool calls.

## Limits and rules

- Each caller may make 30 calls a minute. Scrapy as a whole stops at 1,500 calls a day. Both numbers are settings.
- A personal Scrapy answers a tool call only with its owner's key, and shows its dashboard only to a browser that has logged in.
- Links to private or internal addresses are refused.
- Pages behind a login or a paywall are reported as such. Scrapy does not try to get around them.
- Scrapy says honestly who it is to every service and site: `Scrapy/<version> (+https://github.com/xkilosky/Scrapy)`.
- Vercel's own log gets one line for each call: the tool, how long it took, which ways were tried. The question and the link are not written to it.
- Where the live feed is on, Scrapy itself writes down more: what was asked and what was answered. See [The live feed](#the-live-feed) for where that is and for how long.

## The copycat-site list

[lib/search/junk-sites.ts](lib/search/junk-sites.ts) is a plain list of sites that republish Stack Overflow and GitHub content. Results from them are left out, and every search says how many. Add or remove a line to change it.

## The pages

| Address | What is there | Who can open it |
| --- | --- | --- |
| `/` | The home page: what Scrapy is, the tools, and the way in. | Anybody. |
| `/login` | The login: one password. | Anybody. |
| `/dashboard` | The dashboard, described below. | The owner, logged in. Where Scrapy has no password: everybody who gets there. |
| `/docs` | The docs: "MCP doc" and "For the AI". | Anybody. |
| `/llms.txt` | The rulebook for agents, as plain text. | Anybody. |

A browser that is not logged in and asks for the dashboard is sent to the login, and lands on the part it asked for afterwards (`/dashboard#logs` leads to `/login#logs` and back). Until release G - 1.0 the dashboard was the home page. Links saved then, like `/#try`, are sent on to where that part is now.

### The dashboard

This page is for the owner, not for agents.

The menu button at the top left opens a drawer with sections. The first section, **Dashboard**, has three parts:

1. **Run checks** asks every helper one small thing, times the tools against their targets, switches the first ways off to prove the fallback works, and lists every address that was contacted.
2. **The address for your agent** shows the MCP address to copy, the key of a personal Scrapy (hidden until you ask for it), the tools that are ready, and the limits.
3. **Try a tool** runs `search_web` or `fetch_url` exactly as an agent would and shows the answer the agent gets.

The second section, **Logs**, has one part: the **Live feed** of tool calls. The third section, **Docs**, has two: **MCP doc** and **For the AI**, the same two pages as at `/docs`. Both sections are described below. At the foot of the menu are "Log out" and the release.

One part shows at a time. Each has its own link (`#checks`, `#address`, `#try`, `#logs`, `#mcp-doc`, `#docs-ai`), the back button goes to the part before, and what you typed or checked in one part is still there when you come back to it.

The drawer closes with its close button, with the Escape key, with a click outside it, or when a part is chosen. At an address where Scrapy is closed there is no menu, only the notice. When a login ends while the dashboard is open, the page says so and leads back to the login.

To add a section or an entry, add it to the list in [app/ui/menu.ts](app/ui/menu.ts) and give it its content in [app/ui/Console.tsx](app/ui/Console.tsx).

## The live feed

The feed lists every tool call, the newest at the bottom, the moment Scrapy has answered it. It looks like a terminal: one line for each call with the time, the tool, the question or link, the method, how long it took, and whether it worked.

A line unfolds into a card:

| Field | What it holds |
| --- | --- |
| Timestamp | When the call arrived, in your own time zone. |
| Tool | `search_web` or `fetch_url`. |
| Query or URL | What was asked, and the other arguments. |
| Method | How the answer was obtained (see below), who gave it, and every way that was tried with its time. |
| Duration | From the call arriving to the answer leaving. |
| Result | OK with the length of the answer, or Failed with the sentence the agent got. |
| Called by | An agent over MCP, or the "Try a tool" box. |
| Payload | Unfolds once more into the JSON response, exactly as the agent received it. |

**Method** is one of:

- **Tier 1 (Fast HTTP)**: an ordinary request to a helper. In the middle and full-speed positions it can also be Scrapy's own download.
- **Tier 2 (Real browser)**: a helper read the page in a real browser, for pages built with JavaScript.
- **Memory**: answered from Scrapy's 15-minute memory. Nobody was contacted.
- **None worked** or **Not started**: there is no answer. The card says what was tried, or why nothing was.

**Where it is on.** The log holds what was asked and what was answered, and everybody who can open the dashboard can read it. So it is on where the dashboard is private: wherever Scrapy has a password (only its owner, logged in, can read the log then), on your own machine, and on Vercel's test addresses, which need your Vercel login. On Vercel's public address without a password it is off, and nothing is written down there. `SCRAPY_LOGS=off` switches it off everywhere. `SCRAPY_LOGS=on` switches it on everywhere: use that only for an address that strangers cannot open.

**What is kept.** The last 100 calls, for up to 24 hours. There is no database: on Vercel the log lives in the shared memory (Vercel's Runtime Cache), elsewhere in the memory of the running server. Both may forget earlier. Two servers writing at the same moment can overwrite each other; each server puts its own calls back with its next write, but a call can go missing from the log in a rare case. A call that is turned away because the caller is over a limit is listed once a minute for each caller, not every time.

**What it costs on Vercel's free plan.** While the feed is open and its tab is in front, the page asks Scrapy for news every 2 seconds, every 5 seconds after two quiet minutes, and every 15 seconds after ten. Each question is one small request and one read unit of the shared memory. A tool call costs about 3 to 4 write units. Vercel's free plan includes 1,000,000 read units and 200,000 write units a month for all projects of the account together. When they are used up, Vercel pauses the shared memory for the rest of that month's period: the tools keep working, but the feed on Vercel shows nothing, and says so.

The login of a personal Scrapy counts wrong passwords in the same shared memory, so that several servers count together. A try costs two read units, and a wrong password two write units. A caller who has to wait costs nothing. With the limits on guessing, that is at most about 200 of each an hour while somebody hammers the login, and next to nothing otherwise.

## The docs

Two pages, for two readers. Anybody can read them at `/docs`, and the owner also finds them in the dashboard's menu.

**MCP doc** is for the person who connects an AI to Scrapy. It has four parts: how to connect (the address, the key of a personal Scrapy, and where both go in each kind of AI app), the limits, how Scrapy gets an answer (the fast, free, smart fallback, step by step, for a search and for a page), and how to read the live feed.

**For the AI** is the rulebook an agent follows: which tool to use, the exact parameters of each tool with their types, limits and defaults, examples of what to send, what the answer looks like, and what to do after each kind of failure.

An agent never opens that page. It gets the same rules from Scrapy itself, in three ways:

1. **Over MCP, the moment it connects.** Every agent is handed each tool with its description and its exact parameters. The parameter list allows nothing else (`additionalProperties: false`). Most AI apps also pass on Scrapy's short instructions.
2. **As an MCP resource.** The whole rulebook is the resource `scrapy://rulebook`, for apps that read resources.
3. **As plain text at `/llms.txt`.** An agent that can open a link can read it there, and a person can paste it into the agent's own instructions. The page "For the AI" has a button that copies it.

The page shows a person exactly what the agent is told, so it can be checked.

**One source.** Nothing in the docs is typed in twice. The parameters come from the tools' own definitions in [lib/tools/index.ts](lib/tools/index.ts), the numbers from [lib/config.ts](lib/config.ts) and the settings of the running Scrapy, the list of failures from [lib/errors.ts](lib/errors.ts). [lib/docs.ts](lib/docs.ts) makes the rulebook and everything the two pages show from them. Tests hold the docs and the tools together: every example must be accepted, the sample answers must be what the tools really write, and every failure sentence in the code must start the way the list of failures says.

To change what an agent is told about a tool, change the tool's entry in `lib/tools/index.ts`. The MCP list, the rulebook, `/llms.txt` and both pages follow.

## Working on Scrapy

Needs Node.js 22.

```bash
npm install
npm test          # the tests
npm run typecheck
npm run dev       # Scrapy at http://localhost:3000
npm run build
```

The tests replace the network with stand-ins that answer the way the real helpers document it, so they run anywhere.

### Where things are

| Path | What is there |
| --- | --- |
| `app/api/mcp/route.ts` | The MCP address. |
| `app/page.tsx`, `app/login/`, `app/dashboard/`, `app/docs/` | The home page, the login, the dashboard and the docs. |
| `app/ui/` | What the pages are made of: the dashboard (`Console.tsx`) with its menu drawer and the list of its sections and entries, the login form, the live feed, and the two Docs pages. |
| `app/api/check`, `app/api/try` | Behind the dashboard: the checks, and "Try a tool". |
| `lib/access.ts`, `lib/owner.ts`, `app/api/login`, `app/api/logout` | Who may use Scrapy: the three states, the password, the key of an AI, the pass of a browser, and the brake on guessing. |
| `lib/logs.ts`, `app/api/logs/route.ts` | The log of tool calls behind the live feed. |
| `lib/docs.ts`, `app/api/docs`, `app/llms.txt` | The docs: the rulebook for agents, and everything the Docs pages show. |
| `lib/tools/` | The tools: their parameters, examples and descriptions, the check of what an agent sent, and the text they answer with. |
| `lib/errors.ts` | The reasons a tool can fail for, each with what an agent should do next. |
| `lib/search/` | Asking the engines, merging, the copycat-site list. |
| `lib/page/` | Loading a page, cleaning it, checking it, parts, focus. |
| `lib/providers/` | One file for each helper. Add or drop a helper here. |
| `lib/config.ts` | Every setting and number in one place. |
| `lib/guard.ts`, `lib/limits.ts` | Refusing private addresses, and the two limits. |
| `tests/` | The tests. |

## Hosting

Scrapy is a Next.js app and runs on Vercel's free plan as it is. Import the repository in Vercel. It starts closed at its public address. To make it yours, set `SCRAPY_PASSWORD` (at least 10 characters) in the project's Settings, Environment Variables, for Production and for Preview, and deploy again. Then open `/login`.

`SCRAPY_OPEN=1` opens a Scrapy that has no password to everybody who has the address. With a password it changes nothing.

For a copy of Scrapy that is shown inside a frame on another site's page, as some preview tools do, a browser keeps an ordinary login cookie out. `SCRAPY_FRAMED=1` makes the cookie one that works there. It is ignored on Vercel.

Setting `SCRAPY_BUILD_PROBE=1` makes each Vercel build ask every helper one small thing and write the result into the build log. `SCRAPY_BUILD_PROBE=memory` only tries Vercel's shared memory, which carries the log of tool calls, and contacts no helper.
