# Scrapy: the plan (version 2)

Status: being built. Stage 1 (foundation, search and fetch) is under way, in the safe position. Written 2026-11-11.

Version 1 needed two outside accounts and their keys. You answered "We need totally Free no Key Scrapy" and "The best". This version needs no new account, no key and no payment.

## The short version

Scrapy is a set of web tools that an AI agent calls. Oryzen is the example. People do not use it directly.

- **Where it runs:** Vercel, on the free plan.
- **How the agent connects:** MCP, the common plug-in standard for AI tools.
- **What it has:** seven tools. Your five, plus two I had to add (see [The tools](#the-tools)).
- **What it costs:** nothing. There is no account to create and no key to copy anywhere.
- **How that is possible:** free services that officially offer a door with no key do the searching, and can load the pages. Scrapy does the rest itself: cleaning, picking out text, images and colours, following links. If you choose, it also loads the pages itself.
- **The catch:** those free doors are small and can be busy. Scrapy keeps several for each job, but a tool will sometimes answer "busy, try again".

### The one choice that is yours

Scrapy can load web pages itself. That is the fastest way and it has no daily cap. It carries one risk.

Vercel's fair-use rules list "Scrapers" under "Never fair use". The rules apply on every plan, paid ones included. A Scrapy that downloads pages itself is what that rule names. If Vercel acts on it, it can pause your whole account: Scrapy, `oryzen-preview` and `aiflux` together.

I cannot tell you how likely that is. Vercel calls the list a rule of thumb. It says it aims "to be as permissive as possible without allowing an unreasonable burden on our infrastructure", and that where possible it gets in touch before acting on unreasonable usage. Its terms for the free plan also let it switch a project off without notice.

Scrapy can also stay inside the rules. In the safe position it never loads a page itself. It only asks the free services, and "Functions that query DBs or APIs" is on Vercel's own list of fair use.

| | Safe: free services only | Full speed: Scrapy loads pages itself first |
| --- | --- | --- |
| Vercel's rules | Inside them, as I read them | The use the rule names |
| Speed | Slower | Fastest |
| "Busy, try again" | Possible for every tool | Only for search, and for pages that need a real browser |
| Crawl size | Small. I would cap it at 20 pages. | Up to 100 pages |
| Copying a site's look | The weakest part | More reliable |

Both get built. It is one setting, and you can change it at any time. A middle position also exists: free services first, Scrapy itself only when they are busy.

**My advice: start safe.** Stage 1 measures how well the free services answer from Vercel. If they are good enough, the risk is never needed. If they are not, you decide then, with real numbers: switch to full speed, or move the page-loading part to a host that allows it.

**Where this stands:** you said "Start Building scrappy" without naming a position, so the build started in the safe one. It is one setting, `SCRAPY_MODE`, and it stays your choice.

## Your answers, and what I did with them

| Question | You said | In the plan |
| --- | --- | --- |
| Where should page-fetching happen? | "Free best way", then totally free with no key | No accounts and no keys. Free no-key services load the pages, or Scrapy itself. That is the choice above. |
| May Scrapy load pages itself? | Best results, best tool, free, fast, intelligent | Built both ways. Which one it starts in is the choice above. |
| Should Scrapy have a password? | You are planning that and will tell me later | Left open. See [Access](#access). |
| Who will use Scrapy? | Other people too, no money involved | Vercel's free plan is allowed. Each visitor gets a speed limit. |
| How will the agent call the tools? | MCP | One MCP address. |

## The tools

| Tool | The agent sends | Scrapy returns |
| --- | --- | --- |
| `search_web` | A question. Optionally: how many results, sites to include or leave out, how recent. | A list of results, each with title, link and short description. Duplicates and junk sites are removed. |
| `fetch_url` | A link, and the format: Markdown (default) or HTML. Optionally a focus, such as "rate limits". | The page's main content only. No menus, ads, pop-ups or cookie banners. Long pages come in numbered parts. With a focus, only the matching parts. |
| `extract_text` | A link. | All the visible text, grouped by where it sits: menu, top section, headings with their paragraphs, buttons, footer. |
| `extract_images` | A link. | Every image: its address, description, size if stated, and kind (logo, icon, main picture, background). |
| `extract_design` (new) | A link. | The colour codes and what each is used for, plus fonts, text sizes and button styles. |
| `deep_crawl` | A start link, how deep to follow links, an optional folder such as `/api/`, a page limit, and an optional focus. | For a small crawl, the pages' text straight away. For a bigger one, a job number, while the crawl runs in the background. |
| `crawl_status` (new) | The job number. | Progress, then the pages' text in parts. Results stay available for 1 day. |

Why two new tools:

- **`extract_design`**: you asked for exact colour codes, and neither `extract_images` nor `extract_text` is the natural place for them. The name is my suggestion.
- **`crawl_status`**: a big crawl takes longer than an agent will wait for one answer, so a second tool collects the result.

Every page tool also accepts "use a real browser", for the rare page where Scrapy's own reading misses something.

When a tool cannot do the job, it gives a short plain reason, such as "blocked by the site", "needs a login", "not found", "took too long" or "free services busy, try again in 10 minutes". The agent then knows what to do next.

## How it works

| Job | Scrapy tries first | If that is not enough |
| --- | --- | --- |
| Search | Two free search engines at the same time, results merged. The four are Tavily, Firecrawl, Exa and Parallel. | The other two |
| Read a page | Downloads and cleans the page itself | A helper that reads hard pages in a real browser: Firecrawl, Parallel, Tavily, Exa or Jina |
| Text and images | Works them out from the page it already has | Same as reading a page |
| Colours and fonts | Firecrawl's real-browser reading of the look, if its no-key door includes it | Scrapy reads the page's style files itself |
| Crawl | Scrapy's own link-following, page by page | Same as reading a page |

The table shows the full-speed position. In the safe position Scrapy skips its own downloading and goes straight to the helpers. The design tool then depends on Firecrawl's look report, or on the style rules written inside the page itself.

Each helper sits behind a single small piece of code, so it can be swapped or dropped without touching the tools. The first live test decides which helpers come first.

A crawl runs as a background job on Vercel, which keeps the result for 1 day. So there is still no database.

A correction: version 1 said Vercel has no server that stays running. That was wrong. Vercel offers one, as a test version. Scrapy does not need it.

## What "best, fast and intelligent" means here

**Intelligent** means Scrapy makes the choices, so the agent does not have to.

- It picks the quickest way that works for each page, and remembers what worked for that site.
- It checks its own result before answering. An empty page, a "please turn on JavaScript" page or a block page makes it try the next way.
- Search asks two engines at once and puts first the pages both of them found.
- With a focus, `fetch_url` and `deep_crawl` return the parts of a page that match, not the whole page. This is my suggestion; say so if you do not want it.
- A crawl reads the site's own page list first and follows the most relevant links first.
- `extract_design` says what each colour is for (background, text, main button, links). It is not a bare list of codes.
- A helper that says "slow down" is rested, and the others carry on.

**Fast.** These are targets, not measurements. Stage 1 measures them on the live Scrapy and I report the real numbers. They are for the full-speed position. In the safe position every page takes about as long as a page that needs a real browser.

| Call | Target |
| --- | --- |
| Search | 2 to 3 seconds |
| Ordinary page | 1 to 2 seconds |
| Page that needs a real browser | 5 to 10 seconds |
| The same page again within 15 minutes | Under 1 second |
| Crawl of 25 pages | About 1 minute |

**Best** is judged by the checks in [How we will know it works](#how-we-will-know-it-works), run on the live Scrapy against real pages.

## Free limits

| What | Free allowance | When it runs out |
| --- | --- | --- |
| Vercel free plan | 4 hours of processing and 1 million requests a month, 5 minutes per request. Shared with `oryzen-preview` and `aiflux`. | Vercel pauses instead of billing. Scrapy gets a daily ceiling, so it cannot use up the share of your other projects. |
| Background crawl jobs on Vercel | A monthly allowance. By my estimate, enough for several full-size crawls a day. Stage 3 measures it. | Big crawls answer "crawl allowance used up" until next month. The other tools keep working. |
| Free no-key helpers | Not published. | That helper is rested and the next one is used. If none is left, the tool answers "busy, try again". |

Two things make the helpers' share hard to predict. With no key, a service has to count use some other way, usually by internet address; Firecrawl's documentation says exactly that. And Vercel apps send their requests from a changing pool of addresses shared with other people's apps. That is the main argument for full speed.

## Decisions I made for you

Tell me if you want any of these changed.

- **Built with** TypeScript and Next.js. This is how Vercel's own guide hosts an MCP server.
- **Search** comes from search services. Scrapy does not scrape Google's result pages.
- **"Clean" and "spam"** are decided by fixed rules, not by an AI. Rules cost nothing, are fast and behave the same every time. The junk-site list is a plain file you can edit.
- **Search results**: 8 by default, 20 at most, and no more than 3 from one site.
- **Long pages** come in parts of about 20,000 characters, so one page never floods the agent.
- **Short memory**: Scrapy remembers each page for 15 minutes. If the agent calls four tools on the same page, the page is loaded once.
- **No database** in the first version.
- **Tool names** are the ones you wrote. They are easy to rename.

## Rules Scrapy follows

- When it visits a site itself, it says honestly who it is.
- Crawls stay on the starting site and obey that site's own rules for automated visitors (robots.txt). Links are followed 2 levels deep by default (5 at most), up to 25 pages by default (100 at most), and never more than 2 pages at a time from one site.
- Pages behind a login or a paywall are reported as such. Scrapy does not try to get around them.
- It refuses links to private or internal addresses.
- Each visitor has a speed limit, and Scrapy as a whole has a daily ceiling.

## Access

You are planning whether Scrapy gets a password and will tell me later. Nothing in the build depends on it. It is one setting, and it needs no outside account either way.

Until you decide, Scrapy lives only at a test address. By default Vercel shows test addresses only to someone logged in to your Vercel account. I will confirm that once the project exists. Scrapy gets a public address at the last stage, and I will ask you before that.

One thing to weigh when you decide: with no password, anyone who finds the address can use Scrapy and use up the free doors.

## Not in the first version

- Screenshots of pages.
- An AI model inside Scrapy. Vercel includes a small monthly AI credit that needs no key, so this can be added later for smarter ranking or summaries. It would slow every call down, and the agent calling Scrapy is already an AI.
- Scrapy's own built-in browser. This is the upgrade if the free helpers prove too small.
- PDFs and other files that are not web pages.
- A plain web API next to MCP.
- A usage dashboard.

## Build order

1. **Foundation, search and fetch.** The project skeleton, the MCP address, `search_web` and `fetch_url`. I create the Vercel project and link it to this repository. A check page shows which free helpers answer from Vercel and how fast, with a "Run checks" button and a box to try each tool.
2. **Reference-site tools.** `extract_text`, `extract_images`, `extract_design`.
3. **Crawling.** `deep_crawl` and `crawl_status`.
4. **Going live.** Your access decision, a pull request, the merge into `main`, the public address, then connecting Oryzen.

After each stage I report what was built and what the checks showed.

## What I need from you

**Now:** nothing. The build has started, in the safe position.

**Later.** I will say exactly when, and where to click.

1. Possibly one click so that Vercel can see this GitHub repository.
2. Open the check page, press "Run checks", and send me what it shows. The test address is private to your Vercel login, so I cannot open it myself.
3. Your access decision, before stage 4.
4. Merge the pull request when you are happy with it.
5. Tell me how Oryzen connects to MCP servers, or let me look at its code.

## How we will know it works

| Check | Passes when |
| --- | --- |
| No keys | The Vercel project's settings hold no key from any outside service, and the checks below still pass. |
| Helpers | The check page lists every free helper with "answers" or "does not answer" and its speed. At least two search engines and one real-browser helper answer. |
| Search | A test question returns at least 5 results with title, link and description, no duplicates, none from the junk list. |
| Fetch, short page | `https://example.com` comes back as Markdown containing "Example Domain", with no HTML tags or scripts. |
| Fetch, long page | A long article comes back in parts, and the parts join up into the full text with nothing missing or repeated. |
| Fetch, JavaScript page | A page that shows nothing without JavaScript comes back with its real content. |
| Fallback | With the first way switched off, the same search and the same fetch still succeed through the next way. |
| Safe position | With the setting on safe, Scrapy contacts only the free helpers and never the page's own site. The check page lists every address it contacted. |
| Text | A known page returns its menu items, main heading, button labels and footer text, each in the right group. |
| Images | A known page returns full image addresses, including its logo and its social-preview picture. |
| Design | A known site returns at least 3 colour codes, each with its use, and at least 1 font. |
| Crawl | A small documentation site with a folder filter returns only pages inside that folder, never more than the page limit, and the job reaches "done". |
| Safety | A link to a private address is refused. A visitor over the speed limit is told to slow down. |
| Speed | Each measured time is shown next to its target. |

## Things I could not check yet

- **Real web access.** My build environment can only reach GitHub and the package registries. I cannot load web pages or reach the free helpers from it. So I test the cleaning and extraction code here against saved sample pages, and the real end-to-end check runs on the deployed Scrapy.
- **The free helpers from Vercel.** Each one documents a no-key door. Whether each answers from Vercel's addresses, and how much it gives, only a live call shows. One of them, Exa, says its no-key door refuses some kinds of connection.
- **Firecrawl's look report with no key.** If the no-key door does not include it, `extract_design` uses Scrapy's own reading of the style files, which is less exact.
- **How strictly Vercel applies its scraper rule** to a small tool.
- **How Oryzen connects to MCP servers.**
- **Free doors can change or close** without notice. That is why each helper sits behind one small, replaceable piece of code.
- **The name.** Scrapy is also a well-known Python crawling library. That is fine for a private project. It would clash if you publish this as a package.

## Worth knowing

Firecrawl, Tavily, Exa and Parallel each have a ready-made MCP tool server with a no-key door. Oryzen could connect to one of them directly, with nothing to build. What Scrapy adds on top: your own tool names and result shapes, several engines merged with a spam filter, the text, image and design tools, a real crawl, and no single service it depends on.

## Sources

All checked on 2026-11-11.

- Vercel fair-use rules: https://vercel.com/docs/limits/fair-use-guidelines
- Vercel terms, free plan section: https://vercel.com/legal/terms
- Vercel free plan limits: https://vercel.com/docs/plans/hobby and https://vercel.com/docs/functions/limitations
- Vercel's outgoing addresses are shared and change: https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address
- Hosting an MCP server on Vercel: https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel
- Background jobs on Vercel, free allowance and how long results are kept: https://vercel.com/docs/workflows/pricing and https://vercel.com/docs/workflows/retention
- Reading a background job's result by its number: https://workflow-sdk.dev/docs/api-reference/workflow-api/get-run
- Vercel's short-term cache on the free plan: https://vercel.com/docs/runtime-cache
- Vercel's free monthly AI credit: https://vercel.com/docs/ai-gateway/pricing
- Reports of whole-account pauses (read as search-result summaries, not opened): https://community.vercel.com/t/hobby-plan-paused/2977 and https://community.vercel.com/t/unpausing-vercel-hobby-team-after-fair-use-cpu-usage-limit/34252
- Firecrawl with no key (search, page reading; no crawling): https://docs.firecrawl.dev/rate-limits and https://docs.firecrawl.dev/mcp-server/keyless
- Firecrawl's look report: https://docs.firecrawl.dev/features/scrape
- Tavily with no key (search, page reading; no crawling): https://docs.tavily.com/documentation/keyless
- Exa with no key (search, page reading): https://exa.ai/docs/reference/exa-mcp
- Parallel with no key (search, page reading): https://docs.parallel.ai/integrations/mcp/quickstart
- Jina page reading with no key. I read this in two third-party write-ups, not on Jina's own site: https://agentscamp.com/guides/advanced/jina-reader-api and https://makerstack.co/reviews/jina-reader-review/
