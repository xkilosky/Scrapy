'use client';

import { useState, type FormEvent } from 'react';
import { go } from './go';

type Mode = 'login' | 'signup';

export function AccountAuthForm({ mode }: { mode: Mode }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; confirmationRequired?: boolean } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? `The request did not work (${res.status}).`);
      } else if (mode === 'signup' && data.confirmationRequired) {
        setNotice('Check your email for a confirmation link. Confirm your address, then sign in to create an API key.');
      } else {
        go('/dashboard');
        return;
      }
    } catch {
      setError('The request did not get through. Try again.');
    }
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <label htmlFor="account-email">Email</label>
      <input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor="account-password">Password</label>
      <input id="account-password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} />
      {mode === 'signup' && <p className="soft">Use at least 12 characters. Verify your email before creating keys.</p>}
      <div role="alert" className={error ? 'error' : undefined} style={{ marginTop: 12 }}>{error}</div>
      {notice && <p className="soft" role="status">{notice}</p>}
      <button type="submit" className="primary wide" disabled={busy}>{busy ? 'Working...' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
    </form>
  );
}
