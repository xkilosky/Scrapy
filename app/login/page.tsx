/**
 * The login page. One password, no user name: a personal Scrapy has one owner.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PASSWORD_MIN, RELEASE } from '@/lib/config';
import { LoginForm } from '../ui/LoginForm';
import { viewer } from '../ui/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Log in · Scrapy' };

export default async function LoginPage() {
  const who = await viewer();
  // Nothing to log in to (no password here), or logged in already: straight on.
  if (who.state === 'open' || who.loggedIn) redirect('/dashboard');

  return (
    <main className="login">
      <a className="brand" href="/">
        Scrapy
      </a>
      <section className="card">
        <h1>Log in</h1>
        {who.state === 'closed' ? (
          <>
            <p className="lead">This address is closed. Its owner has not opened it yet, so there is nothing to log in to.</p>
            <p className="soft" style={{ marginBottom: 0 }}>
              If this is your Scrapy: give it a password with the setting <code>SCRAPY_PASSWORD</code>. It then answers to you alone, and this page asks for that password.
            </p>
          </>
        ) : who.locked ? (
          <>
            <p className="lead">Nobody can log in right now.</p>
            <div className="error" role="alert" style={{ marginTop: 0 }}>
              The password set for this Scrapy is too short. If this is your Scrapy: set one of at least {PASSWORD_MIN} characters, in the setting <code>SCRAPY_PASSWORD</code>.
            </div>
          </>
        ) : (
          <>
            <p className="lead">This Scrapy is personal. Its password opens the dashboard.</p>
            <LoginForm />
          </>
        )}
      </section>
      <p className="soft login-foot">
        <a href="/">Home page</a> · <a href="/docs">Docs</a> · Scrapy {RELEASE}
      </p>
    </main>
  );
}
