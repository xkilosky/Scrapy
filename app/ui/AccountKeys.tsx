'use client';

import { useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { go } from './go';

type KeyRecord = {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  per_minute_limit: number;
  daily_limit: number;
  used_this_minute: number;
  used_today: number;
};

type InstanceStatus = {
  limits: { dailyCalls: number };
  usage: { today: number };
};

export function AccountKeys({ email }: { email: string }) {
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [instanceStatus, setInstanceStatus] = useState<InstanceStatus | null>(null);
  const [label, setLabel] = useState('My AI app');
  const [fresh, setFresh] = useState<{ key: string; record: KeyRecord } | null>(null);
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadKeys() {
    const response = await fetch('/api/account/keys', { cache: 'no-store' });
    const data = (await response.json().catch(() => null)) as { keys?: KeyRecord[]; error?: string } | null;
    if (response.status === 401) { go('/login'); return; }
    if (!response.ok || !data?.keys) throw new Error(data?.error ?? 'Keys could not be loaded.');
    setKeys(data.keys);
  }

  async function loadInstanceStatus() {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (response.status === 401) { go('/login'); return; }
    if (!response.ok) return;
    const data = (await response.json().catch(() => null)) as InstanceStatus | null;
    if (data?.limits && data?.usage) setInstanceStatus(data);
  }

  useEffect(() => {
    setOrigin(window.location.origin);
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadKeys().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Keys could not be loaded.'));
      void loadInstanceStatus();
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  async function makeKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setFresh(null);
    try {
      const response = await fetch('/api/account/keys', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
      });
      const data = (await response.json().catch(() => null)) as { key?: string; record?: KeyRecord; error?: string } | null;
      if (response.status === 401) { go('/login'); return; }
      if (!response.ok || !data?.key || !data.record) throw new Error(data?.error ?? 'The key could not be created.');
      setFresh({ key: data.key, record: data.record });
      setKeys((current) => [data.record as KeyRecord, ...current]);
      setNotice('Copy this key now. Scrapy stores only its hash and cannot show it again.');
      setLabel('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The key could not be created.');
    }
    setBusy(false);
  }

  async function revoke(record: KeyRecord) {
    if (busy || !window.confirm(`Turn off “${record.label}”? Any AI using it will stop working.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/account/keys', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: record.id }),
      });
      const data = (await response.json().catch(() => null)) as { found?: boolean; error?: string } | null;
      if (response.status === 401) { go('/login'); return; }
      if (!response.ok || !data?.found) throw new Error(data?.error ?? 'The key was not active.');
      const revokedAt = new Date().toISOString();
      setKeys((current) => current.map((key) => key.id === record.id ? { ...key, revoked_at: revokedAt } : key));
      if (fresh?.record.id === record.id) setFresh(null);
      setNotice(`“${record.label}” has been turned off.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The key could not be turned off.');
    }
    setBusy(false);
  }

  async function signOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      go('/');
    } catch {
      setError('Could not sign out. Try again.');
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="top">
        <h1>Scrapy</h1>
        <span className="pill">API keys</span>
        <button type="button" className="button small" onClick={() => void signOut()} disabled={busy}>Sign out</button>
      </div>
      <p className="lead">Signed in as {email}. Create a separate key for each AI app, and turn a key off whenever you need to.</p>
      {instanceStatus && (
        <section className="card quota-card" aria-labelledby="instance-usage-title">
          <h2 id="instance-usage-title">Scrapy&apos;s shared daily usage</h2>
          <p>{instanceStatus.usage.today.toLocaleString()} of {instanceStatus.limits.dailyCalls.toLocaleString()} calls used today (UTC) across the whole instance. This shared total may lag briefly between servers.</p>
          <progress
            className="quota-progress"
            max={instanceStatus.limits.dailyCalls}
            value={Math.min(instanceStatus.usage.today, instanceStatus.limits.dailyCalls)}
            aria-label={`Shared daily usage: ${instanceStatus.usage.today} of ${instanceStatus.limits.dailyCalls} calls`}
          />
        </section>
      )}
      <section className="card">
        <h2>Create a key</h2>
        <p>Each key allows 30 tool calls per minute and 500 per day. The whole Scrapy instance also keeps its 1,500-call daily ceiling.</p>
        <form onSubmit={(event) => void makeKey(event)}>
          <label htmlFor="key-label">Name this key</label>
          <input id="key-label" maxLength={64} required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Claude Desktop" />
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Working...' : 'Create key'}</button>
        </form>
        {fresh && (
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Copy your new key now</h3>
            <p>This is the only time it will be shown.</p>
            <pre style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{fresh.key}</pre>
            <CopyButton text={fresh.key} label="Copy key" />
            <p className="soft">MCP address: <code>{origin}/api/mcp</code>. Send the key in the <code>Authorization: Bearer</code> header.</p>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Your keys</h2>
        {keys.length === 0 ? <p>No keys yet. Create one above to connect an AI app.</p> : (
          <div className="scroll">
            <table>
              <thead><tr><th>Name</th><th>Key</th><th>Usage</th><th>Last used</th><th>Status</th><th /></tr></thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td>{key.label}</td>
                    <td><code>{key.key_prefix}…</code></td>
                    <td>
                      <div className="quota-meters">
                        <div className="quota-meter">
                          <span><span>Current minute</span><span>{key.used_this_minute}/{key.per_minute_limit}</span></span>
                          <progress className="quota-progress" max={key.per_minute_limit} value={Math.min(key.used_this_minute, key.per_minute_limit)} aria-label={`${key.label}: ${key.used_this_minute} of ${key.per_minute_limit} calls this minute`} />
                        </div>
                        <div className="quota-meter">
                          <span><span>Today (UTC)</span><span>{key.used_today}/{key.daily_limit}</span></span>
                          <progress className="quota-progress" max={key.daily_limit} value={Math.min(key.used_today, key.daily_limit)} aria-label={`${key.label}: ${key.used_today} of ${key.daily_limit} calls today UTC`} />
                        </div>
                      </div>
                    </td>
                    <td>{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'Not used yet'}</td>
                    <td>{key.revoked_at ? 'Off' : 'Active'}</td>
                    <td>{!key.revoked_at && <button type="button" className="button small" disabled={busy} onClick={() => void revoke(key)}>Turn off</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div role="alert" className={error ? 'error' : undefined}>{error}</div>
      {notice && <p className="soft" role="status">{notice}</p>}
      <p className="soft"><a href="/docs">Docs</a> · <a href="/">Home page</a></p>
    </main>
  );
}
