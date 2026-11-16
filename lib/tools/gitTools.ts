/** Public GitHub tools. Search endpoints need no credentials except code search, which GitHub gates behind login. */
import { ScrapyError, waitText } from '../errors';
import { httpCall } from '../http';
import { searchWebTool } from './searchWeb';
import type { Trace } from '../trace';

const API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

type Obj = Record<string, unknown>;
function obj(value: unknown): Obj { return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}; }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function int(value: unknown): number { return typeof value === 'number' ? value : 0; }
function oneLine(value: unknown, max = 320): string { return text(value).replace(/\s+/g, ' ').trim().slice(0, max); }

async function githubJson(url: string, trace: Trace, purpose: string, maxBytes = 2_000_000): Promise<unknown> {
  const result = await httpCall(trace, { url, headers: HEADERS, timeoutMs: TIMEOUT_MS, maxBytes, purpose });
  if (result.status === 404) throw new ScrapyError('not_found', `Not found: GitHub has no matching repository, file or branch (${url.replace(API, 'GitHub')}).`);
  if (result.status === 401) throw new ScrapyError('login', 'Needs a login: GitHub requires a login for this search. Repository and issue search are public; code search is available through search_web instead.');
  if (result.status === 403 || result.status === 429) {
    const wait = Number(result.headers.get('retry-after')) || 60;
    throw new ScrapyError('busy', `GitHub is busy or its free search allowance is used up. Try again ${waitText(wait)}.`, wait);
  }
  if (result.status < 200 || result.status >= 300) throw new ScrapyError('failed', `GitHub answered ${result.status}; try again later.`);
  const value = result.json();
  if (value === undefined) throw new ScrapyError('failed', 'GitHub returned unreadable data. Try again later.');
  return value;
}

function searchUrl(type: string, query: string, language?: string): string {
  const q = [query.trim(), ...(language?.trim() ? [`language:${language.trim()}`] : [])].filter(Boolean).join(' ');
  const params = new URLSearchParams({ q, per_page: '10' });
  return `${API}/search/${type}?${params}`;
}

export async function gitSearch(args: { query: string; type: 'repositories' | 'code' | 'issues'; language?: string }, trace: Trace): Promise<string> {
  if (args.type === 'code') {
    const query = [args.query, args.language ? `language:${args.language}` : ''].filter(Boolean).join(' ');
    return `GitHub requires an account for its code-search API. Searching public GitHub pages instead:\n\n${await searchWebTool({ query, max_results: 8, include_sites: ['github.com'] }, trace)}`;
  }
  const data = obj(await githubJson(searchUrl(args.type, args.query, args.language), trace, `GitHub ${args.type} search`));
  const items = Array.isArray(data.items) ? data.items.map(obj) : [];
  const total = int(data.total_count);
  if (!items.length) return `No ${args.type} found for "${args.query}"${args.language ? ` (${args.language})` : ''}.`;
  const lines = [`${total.toLocaleString('en-US')} ${args.type} found; showing ${items.length}.`, ''];
  for (const [i, item] of items.entries()) {
    if (args.type === 'repositories') {
      const full = text(item.full_name, 'unknown/unknown');
      lines.push(`${i + 1}. ${full} — ${oneLine(item.description, 240) || 'No description.'}`, `   ${text(item.html_url)}`, `   ${int(item.stargazers_count).toLocaleString('en-US')} stars · ${text(item.language, 'language not listed')} · ${text(item.license && obj(item.license).spdx_id, 'license not listed')}`);
    } else {
      lines.push(`${i + 1}. ${oneLine(item.title, 220)}`, `   ${text(item.html_url)}`, `   ${text(obj(item.repository).full_name)} · ${text(item.state)} · opened ${text(item.created_at).slice(0, 10)}`, `   ${oneLine(item.body, 240)}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function repoPath(owner: string, repo: string, endpoint: string): string {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${endpoint}`;
}

function decodeContent(encoded: string): string {
  return Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8');
}

export async function fetchGit(args: { repo_owner: string; repo_name: string }, trace: Trace): Promise<string> {
  const root = repoPath(args.repo_owner, args.repo_name, '');
  const meta = obj(await githubJson(root, trace, 'GitHub repository details'));
  const [readmeRaw, treeRaw] = await Promise.all([
    githubJson(`${root}/readme`, trace, 'GitHub README').catch((err: unknown) => {
      if (err instanceof ScrapyError && err.reason === 'not_found') return {};
      throw err;
    }),
    githubJson(repoPath(args.repo_owner, args.repo_name, `/git/trees/${encodeURIComponent(text(meta.default_branch, 'main'))}?recursive=1`), trace, 'GitHub repository file tree', 16_000_000),
  ]);
  const readme = obj(readmeRaw);
  const body = typeof readme.content === 'string' ? decodeContent(readme.content) : '(No README was returned.)';
  const clippedReadme = body.length > 16_000 ? `${body.slice(0, 16_000)}\n\n[README clipped at 16,000 characters.]` : body;
  const tree = obj(treeRaw);
  const entries = Array.isArray(tree.tree) ? tree.tree.map(obj) : [];
  const files = entries.filter((entry) => entry.type === 'blob').map((entry) => text(entry.path)).filter(Boolean);
  const shown = files.slice(0, 250);
  return [
    `${text(meta.full_name)} — ${oneLine(meta.description) || 'No description.'}`,
    text(meta.html_url),
    `Stars: ${int(meta.stargazers_count).toLocaleString('en-US')} · Default branch: ${text(meta.default_branch)} · License: ${text(obj(meta.license).spdx_id, 'not listed')}`,
    '', 'README:', clippedReadme, '', `Files (${shown.length}${files.length > shown.length ? ` of ${files.length}` : ''}${tree.truncated === true ? ', GitHub tree was truncated' : ''}):`,
    ...shown.map((path) => `- ${path}`),
    ...(files.length > shown.length ? [`- … ${files.length - shown.length} more files not shown`] : []),
  ].join('\n');
}

export async function fetchGitDeep(args: { repo_owner: string; repo_name: string; file_path: string; branch?: string }, trace: Trace): Promise<string> {
  const branch = args.branch?.trim() || 'main';
  const path = args.file_path.split('/').map(encodeURIComponent).join('/');
  const endpoint = `/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const raw = obj(await githubJson(repoPath(args.repo_owner, args.repo_name, endpoint), trace, 'GitHub source file'));
  if (raw.type !== 'file' || typeof raw.content !== 'string') throw new ScrapyError('not_found', 'Not found: that path is not a file in this repository. Give the path to one file, not a directory.');
  const content = decodeContent(raw.content);
  const max = 40_000;
  const display = content.length > max ? `${content.slice(0, max)}\n\n[File clipped at ${max.toLocaleString('en-US')} characters.]` : content;
  const bytes = typeof raw.size === 'number' ? raw.size : Buffer.byteLength(content);
  return `${text(raw.path, args.file_path)} (${bytes.toLocaleString('en-US')} bytes) — ${text(raw.html_url)}\n\n${display}`;
}
