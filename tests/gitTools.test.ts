import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetch, type FetchFn } from '@/lib/http';
import { fetchGit, fetchGitDeep, gitSearch } from '@/lib/tools/gitTools';
import { Trace } from '@/lib/trace';

afterEach(() => {
  setFetch(null);
  delete process.env.SCRAPY_SEARCH_ORDER;
});

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function encoded(content: string): string {
  return Buffer.from(content).toString('base64');
}

describe('GitHub tools', () => {
  it('searches repositories and passes the query and language filter to GitHub', async () => {
    const fetch = vi.fn<FetchFn>(async (input) => {
      const url = String(input);
      expect(url).toContain('/search/repositories?');
      expect(url).toContain('language%3AtypeScript');
      return reply({ total_count: 1, items: [{ full_name: 'org/charts', description: 'A chart toolkit', html_url: 'https://github.com/org/charts', stargazers_count: 12, language: 'TypeScript', license: { spdx_id: 'MIT' } }] });
    });
    setFetch(fetch);
    const answer = await gitSearch({ query: 'chart toolkit', type: 'repositories', language: 'typeScript' }, new Trace());
    expect(answer).toContain('1 repositories found; showing 1.');
    expect(answer).toContain('org/charts — A chart toolkit');
    expect(answer).toContain('12 stars · TypeScript · MIT');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the public web search for code because GitHub gates its API behind login', async () => {
    process.env.SCRAPY_SEARCH_ORDER = 'tavily';
    setFetch(async (input, init) => {
      expect(String(input)).toBe('https://api.tavily.com/search');
      const sent = JSON.parse(String(init?.body)) as { query: string; include_domains: string[] };
      expect(sent.query).toContain('useAuth hook language:javascript');
      expect(sent.include_domains).toEqual(['github.com']);
      return reply({ results: [{ url: 'https://github.com/acme/hooks/blob/main/useAuth.js', title: 'acme/hooks useAuth', content: 'A hook implementation.' }] });
    });
    const answer = await gitSearch({ query: 'useAuth hook', type: 'code', language: 'javascript' }, new Trace());
    expect(answer).toContain('GitHub requires an account for its code-search API.');
    expect(answer).toContain('https://github.com/acme/hooks/blob/main/useAuth.js');
  });

  it('fetches repository metadata, README and the recursive file tree', async () => {
    setFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/repos/acme/widget')) return reply({ full_name: 'acme/widget', description: 'A widget', html_url: 'https://github.com/acme/widget', stargazers_count: 4, default_branch: 'trunk', license: { spdx_id: 'Apache-2.0' } });
      if (url.endsWith('/repos/acme/widget/readme')) return reply({ content: encoded('# Widget\nA useful thing.') });
      if (url.includes('/git/trees/trunk?recursive=1')) return reply({ tree: [{ type: 'blob', path: 'src/index.ts' }, { type: 'tree', path: 'src' }] });
      throw new Error(`unexpected URL ${url}`);
    });
    const answer = await fetchGit({ repo_owner: 'acme', repo_name: 'widget' }, new Trace());
    expect(answer).toContain('acme/widget — A widget');
    expect(answer).toContain('# Widget\nA useful thing.');
    expect(answer).toContain('Files (1):\n- src/index.ts');
  });

  it('reads and decodes one file on the requested branch', async () => {
    let requested = '';
    setFetch(async (input) => {
      requested = String(input);
      return reply({ type: 'file', path: 'src/main.ts', size: 16, html_url: 'https://github.com/acme/widget/blob/next/src/main.ts', content: encoded('export default 1;') });
    });
    const answer = await fetchGitDeep({ repo_owner: 'acme', repo_name: 'widget', file_path: 'src/main.ts', branch: 'next' }, new Trace());
    expect(requested).toContain('/contents/src/main.ts?ref=next');
    expect(answer).toContain('src/main.ts (16 bytes)');
    expect(answer).toContain('export default 1;');
  });

  it('turns missing repository/file and rate limits into short, actionable errors', async () => {
    setFetch(async () => reply({ message: 'Not Found' }, 404));
    await expect(gitSearch({ query: 'missing', type: 'repositories' }, new Trace())).rejects.toThrow(/^Not found:/);
    setFetch(async () => reply({ message: 'API rate limit exceeded' }, 403));
    await expect(gitSearch({ query: 'popular', type: 'issues' }, new Trace())).rejects.toThrow(/^GitHub is busy/);
  });
});
