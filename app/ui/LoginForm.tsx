'use client';

/**
 * The form on the login page. After the right password, the browser has its
 * pass, and the page goes on to the dashboard: to the part that was asked for
 * when there was one ("/login#logs" leads to "/dashboard#logs").
 */
import { useState, type FormEvent } from 'react';
import { go } from './go';

/**
 * Did the browser keep the pass it was just handed? It does not when this page
 * is shown inside another site's page, or when the browser refuses cookies.
 * Without this look, the dashboard would send the owner straight back here,
 * with no word about why. Without an answer, the dashboard is tried.
 */
async function kept(): Promise<boolean> {
  try {
    const status = (await (await fetch('/api/status', { cache: 'no-store' })).json()) as { allowed?: boolean };
    return status.allowed !== false;
  } catch {
    return true;
  }
}

export function LoginForm() {
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** True when the password was right and the browser did not keep the login. */
  const [notKept, setNotKept] = useState(false);

  async function logIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password.trim() === '') {
      setError('Type the password.');
      return;
    }
    setBusy(true);
    setError('');
    setNotKept(false);
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        if (await kept()) {
          go(`/dashboard${window.location.hash}`);
          return;
        }
        setNotKept(true);
      } else {
        setError(data?.error ?? `The login did not work (${res.status}). Try again.`);
      }
    } catch {
      setError('The request did not get through. Try again.');
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void logIn(event)} noValidate>
      {/* There is one owner and no user name. This field only gives a password manager something to file the password under. */}
      <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
      <label htmlFor="password">Password</label>
      <input
        id="password"
        name="password"
        type={shown ? 'text' : 'password'}
        autoComplete="current-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        // The password is the only thing to do on this page.
        autoFocus
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-invalid={error !== ''}
        aria-describedby={error || notKept ? 'login-error' : undefined}
      />
      <label className="check">
        <input type="checkbox" checked={shown} onChange={(event) => setShown(event.target.checked)} /> Show the password
      </label>
      {/* Always there, so that a screen reader says the message when it appears. */}
      <div id="login-error" role="alert" className={error || notKept ? 'error' : undefined}>
        {error}
        {notKept && (
          <>
            The password is right, but this browser did not keep the login. That happens when Scrapy is shown inside another site&apos;s page, or when the browser refuses cookies.{' '}
            <a href="/login" target="_blank" rel="noopener">
              Open Scrapy in a tab of its own
            </a>{' '}
            and log in there.
          </>
        )}
      </div>
      <button type="submit" className="primary wide" disabled={busy}>
        {busy ? 'Logging in...' : 'Log in'}
      </button>
    </form>
  );
}
