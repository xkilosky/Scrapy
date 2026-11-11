# Scrapy

Web tools for AI agents. An agent connects once, over MCP, and can then search the web and read pages. Scrapy is free to run and needs no key and no account anywhere.

People do not use Scrapy directly. An AI agent does, for example to find out how to fix a bug or to read a documentation page.

**Status:** stage 1 of 4. `search_web` and `fetch_url` work. The full plan is in [PLAN.md](PLAN.md).

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

## How it works

**No keys.** Scrapy uses free services that officially offer a door with no key: Tavily, Firecrawl, Exa, Parallel and Jina Reader. This README calls them helpers. Their free allowances are small and not published, so Scrapy keeps several for each job.

**Search.** Two search engines are asked at the same time and their results are merged. A page that both found is listed once and ranked first. Results from copycat sites are removed, and no more than three results come from one site. If the first two engines fail or find too little, the other two are asked.

**Reading a page.** Scrapy tries the ways of loading a page in order and checks each result itself. A page that came back empty, that only says "turn on JavaScript", or that is a block page is not an answer, and the next way is tried. When a way is slow, the next one is started alongside and the first good answer wins. Scrapy remembers which way worked for a site.

**Resting.** A helper that says "slow down" is left alone for as long as it asked, and the others carry on.

**Memory.** Every page and every search is remembered for 15 minutes, so asking twice costs nothing. There is no database.

**Rules, not AI.** What counts as "clean", as a duplicate or as a copycat site is decided by fixed rules. They cost nothing, they are fast, and the same input always gives the same output.

## The three positions

One setting, `SCRAPY_MODE`, decides how pages get loaded.

| Position | What Scrapy does | Good to know |
| --- | --- | --- |
| `safe` (the default) | Only asks the helpers. It never downloads a page itself. | Every tool can answer "busy" when the helpers' free allowances run out. |
| `middle` | Helpers first. Downloads a page itself only when they are busy. | |
| `full` | Downloads pages itself first. Helpers only for pages that need a real browser. | Fastest, with no daily cap on ordinary pages. |

Before choosing `middle` or `full` on Vercel, read Vercel's [fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines). They list "Scrapers" under "Never fair use", on every plan. A Scrapy that downloads pages itself is what that rule names. In the `safe` position Scrapy only calls other services' APIs, which the same guidelines list as fair use.

The check page shows every address Scrapy contacted, so the safe position can be verified instead of trusted.

## Open or closed

On Vercel, Scrapy's public address stays **closed** until its owner sets `SCRAPY_OPEN=1`. A closed Scrapy answers every call with one sentence and contacts nobody. So nobody can find the address and use up the free allowances before the owner has decided who may use it.

Vercel's test addresses are always open. Vercel only shows them to people logged in to the owner's account.

Good to know: Vercel makes the very first deployment of a new project the public one, whichever branch it comes from.

## Settings

All settings are optional environment variables, and none of them is a key. They are listed with explanations in [.env.example](.env.example): the position, the order of the helpers, helpers to switch off, and the two limits.

## Limits and rules

- Each visitor may make 30 calls a minute. Scrapy as a whole stops at 1,500 calls a day. Both numbers are settings.
- Links to private or internal addresses are refused.
- Pages behind a login or a paywall are reported as such. Scrapy does not try to get around them.
- Scrapy says honestly who it is to every service and site: `Scrapy/<version> (+https://github.com/xkilosky/Scrapy)`.
- Scrapy's log holds one line for each call: the tool, how long it took, which ways were tried. The question and the link are not written to the log.

## The copycat-site list

[lib/search/junk-sites.ts](lib/search/junk-sites.ts) is a plain list of sites that republish Stack Overflow and GitHub content. Results from them are left out, and every search says how many. Add or remove a line to change it.

## The check page

Open Scrapy's address in a browser. The page has two parts:

1. **Run checks** asks every helper one small thing, times the tools against their targets, and lists every address that was contacted.
2. **Try a tool** runs `search_web` or `fetch_url` exactly as an agent would and shows the answer the agent gets.

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
| `app/page.tsx`, `app/api/check`, `app/api/try` | The check page. |
| `lib/tools/` | The tools, and the text they answer with. |
| `lib/search/` | Asking the engines, merging, the copycat-site list. |
| `lib/page/` | Loading a page, cleaning it, checking it, parts, focus. |
| `lib/providers/` | One file for each helper. Add or drop a helper here. |
| `lib/config.ts` | Every setting and number in one place. |
| `lib/guard.ts`, `lib/limits.ts` | Refusing private addresses, and the two limits. |
| `tests/` | The tests. |

## Hosting

Scrapy is a Next.js app and runs on Vercel's free plan as it is. Import the repository in Vercel. It starts closed at its public address; set `SCRAPY_OPEN=1` to open it.

Setting `SCRAPY_BUILD_PROBE=1` makes each Vercel build ask every helper one small thing and write the result into the build log.
