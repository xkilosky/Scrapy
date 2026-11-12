'use client';

import { useState } from 'react';

/** A button that copies a text, and says so for a moment. */
export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

/**
 * A block of code or text. A bar on top says what it is, and has the copy button.
 *
 * Code keeps its lines and is scrolled sideways when it is too wide. With
 * "wrap", a long line is broken instead: for a single line of JSON.
 *
 * With "copy", the button copies that text instead of the one shown: for a
 * block that shows YOUR_KEY and copies the real key, which stays off the screen.
 */
export function CodeBlock({ code, label, caption, wrap = false, copy }: { code: string; label: string; caption: string; wrap?: boolean; copy?: string }) {
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span>{caption}</span>
        <CopyButton text={copy ?? code} label={copy !== undefined && copy !== code ? 'Copy with your key' : 'Copy'} className="codeblock-copy" />
      </div>
      {/* A name and a place in the Tab order, so that a keyboard can scroll it. A name needs a role. */}
      <pre role="group" aria-label={label} tabIndex={0} className={wrap ? undefined : 'keep'}>
        {code}
      </pre>
    </div>
  );
}
