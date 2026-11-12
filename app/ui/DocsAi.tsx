'use client';

/**
 * Docs for the AI: the rulebook an agent follows when it uses Scrapy.
 *
 * An agent never opens this page. Scrapy tells it the rules itself, over MCP.
 * This page shows the person exactly what the agent is told, and gives them
 * the same rules as text for an agent that needs them spelled out.
 *
 * Everything shown is read from the running Scrapy (lib/docs.ts), which makes
 * it from the tools' own definitions. Nothing is written a second time here.
 */
import type { DocsPayload, ToolDoc } from '@/lib/docs';
import { CodeBlock, CopyButton } from './CopyButton';

/** Arguments as JSON on one line, with room to breathe: { "query": "x", "max_results": 5 }. */
export function onOneLine(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 1).replace(/\n\s*/g, ' ');
}

function Tool({ tool }: { tool: ToolDoc }) {
  return (
    <section className="card doc" aria-labelledby={`tool-${tool.name}`}>
      <h2 id={`tool-${tool.name}`}>
        <code className="tool-name">{tool.name}</code> <span className="soft tool-title">{tool.title}</span>
      </h2>
      <p>{tool.description}</p>

      <h3>The exact parameters</h3>
      <div className="scroll">
        <table className="params">
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Type</th>
              <th>Needed</th>
              <th>What it is for</th>
            </tr>
          </thead>
          <tbody>
            {tool.params.map((p) => (
              <tr key={p.name}>
                <td className="mono nowrap">{p.name}</td>
                <td>
                  <span className="mono">{p.type}</span>
                  {p.limits && <span className="under">{p.limits}</span>}
                </td>
                <td className="nowrap">
                  {p.required ? <strong>required</strong> : 'optional'}
                  {p.default !== undefined && (
                    <span className="under">
                      default <span className="mono">{p.default}</span>
                    </span>
                  )}
                </td>
                <td className="note">{p.about}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="soft small" style={{ marginTop: 10 }}>
        These are all the parameters there are. One that is not in this list is refused.
      </p>

      <h3>Examples of what the AI sends</h3>
      {tool.examples.map((example) => (
        <CodeBlock key={example.about} code={onOneLine(example.args)} caption={example.about} label={`${tool.name}: ${example.about}`} wrap />
      ))}

      <h3>What comes back</h3>
      <CodeBlock code={tool.answer.sample} caption="An example answer" label={`An example answer of ${tool.name}`} />
      <ul className="notes">
        {tool.answer.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      <h3>When the AI guesses</h3>
      <p>
        An AI that makes up a parameter gets it back at once, with the real parameters next to it, so it can correct itself on the next call. For example, to <code>{JSON.stringify(tool.wrongInput.args)}</code> Scrapy answers:
      </p>
      <blockquote className="said">{tool.wrongInput.answer}</blockquote>
      <p className="soft small" style={{ marginBottom: 0 }}>
        Only the form of a value is forgiven, where it can mean one thing only: a number or true/false written as text, one item where a list is expected, and null or an empty text for a parameter that is not used. Such a call is carried out.
      </p>
    </section>
  );
}

export function DocsAi({ docs, origin, failed, onRetry }: { docs: DocsPayload | null; origin: string; failed: boolean; onRetry: () => void }) {
  if (failed) {
    return (
      <section className="card">
        <div className="error" style={{ marginTop: 0 }}>
          The docs could not be loaded from Scrapy.
        </div>
        <button type="button" style={{ marginTop: 12 }} onClick={onRetry}>
          Try again
        </button>
      </section>
    );
  }
  if (!docs || !origin) return <p className="soft">Loading the docs...</p>;

  // Vercel's test addresses are behind Vercel's login. That goes for /llms.txt too.
  const guarded = docs.facts.where.vercel && docs.facts.where.env === 'preview';
  // The text at /llms.txt starts with Scrapy's address. This copy gets the same line.
  const rulebook = docs.rulebook.replace('\n\n## Which tool to use', `\n\nMCP address: ${origin}/api/mcp (Streamable HTTP, no key needed).\n\n## Which tool to use`);

  return (
    <>
      <section className="card doc" aria-labelledby="ai-how-title">
        <h2 id="ai-how-title">How your AI gets these rules</h2>
        <p>
          Your AI never opens this page. Scrapy tells it the rules itself. This page shows you exactly what it is told, so you can check it, and gives you the same rules as text in case your AI needs them spelled out.
        </p>
        <ol className="ways">
          <li>
            <strong>When it connects. Nothing to do.</strong> MCP hands your AI each tool with its description and its exact parameters, as shown below. Most AI apps also pass on Scrapy&apos;s short instructions.
          </li>
          <li>
            <strong>As a document it can read over MCP.</strong> The whole rulebook is the resource <code>{docs.rulebookUri}</code>. An AI app that supports MCP resources can open it.
          </li>
          <li>
            <strong>As text you give it.</strong> If your AI still guesses, paste the rulebook into its own instructions (its system prompt), or let it read <a href="/llms.txt">/llms.txt</a>.
            {guarded && ' At this test address Vercel asks for a login first, so an AI can open /llms.txt only with the secret header that the MCP doc describes. Pasting works without it.'}
            <div className="row" style={{ marginTop: 10 }}>
              <CopyButton text={rulebook} label="Copy the rulebook" className="primary" />
              <a className="button" href="/llms.txt" target="_blank" rel="noreferrer">
                Open /llms.txt
              </a>
            </div>
          </li>
        </ol>
      </section>

      <section className="card doc" aria-labelledby="ai-first-title">
        <h2 id="ai-first-title">What every AI is told when it connects</h2>
        <p className="soft">Scrapy&apos;s instructions, word for word:</p>
        <blockquote className="said">{docs.instructions}</blockquote>
        <p className="soft small" style={{ marginBottom: 0 }}>
          Then it gets the {docs.tools.length} tools below: {docs.tools.map((t) => t.name).join(' and ')}.
        </p>
      </section>

      {docs.tools.map((tool) => (
        <Tool key={tool.name} tool={tool} />
      ))}

      <section className="card doc" aria-labelledby="ai-fail-title">
        <h2 id="ai-fail-title">When a tool cannot do the job</h2>
        <p>The tool then answers with a sentence that says why, marked as an error. The rulebook tells the AI what to do after each kind:</p>
        <div className="scroll">
          <table className="stack labelled">
            <thead>
              <tr>
                <th>The answer starts with</th>
                <th>What it means</th>
                <th>What the AI should do</th>
              </tr>
            </thead>
            <tbody>
              {docs.failures.map((failure) => (
                <tr key={failure.reason}>
                  <td>
                    {failure.starts.map((start) => (
                      <div key={start} className="mono starts">
                        {start}
                      </div>
                    ))}
                  </td>
                  <td className="note" data-label="It means">
                    {failure.means}
                  </td>
                  <td className="note" data-label="The AI should">
                    {failure.then}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card doc" aria-labelledby="ai-text-title">
        <div className="row between">
          <h2 id="ai-text-title">The whole rulebook, as the AI reads it</h2>
          <CopyButton text={rulebook} label="Copy the rulebook" />
        </div>
        <p className="soft">This is the text behind the resource and behind /llms.txt. It is written for an AI: short rules, exact names.</p>
        <details>
          <summary>Show the rulebook ({rulebook.length.toLocaleString('en-US')} characters)</summary>
          <pre className="rulebook" role="group" aria-label="The rulebook for AI agents" tabIndex={0}>
            {rulebook}
          </pre>
        </details>
      </section>

      <p className="soft small doc-foot">
        How to connect your AI, and the limits, are in the <a href="#mcp-doc">MCP doc</a>.
      </p>
    </>
  );
}
