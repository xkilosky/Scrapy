import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { access } from '@/lib/access';
import { AccountAuthForm } from '../ui/AccountAuthForm';
import { viewer } from '../ui/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Create account · Scrapy' };

export default async function SignupPage() {
  if (access() !== 'accounts') redirect('/');
  const who = await viewer();
  if (who.loggedIn) redirect('/dashboard');
  return (
    <main className="login">
      <a className="brand" href="/">Scrapy</a>
      <section className="card">
        <h1>Create your account</h1>
        <p className="lead">Verify your email, then create API keys for your AI apps.</p>
        <AccountAuthForm mode="signup" />
        <p className="soft">Already have an account? <a href="/login">Sign in</a>.</p>
      </section>
      <p className="soft login-foot"><a href="/">Home page</a> · <a href="/docs">Docs</a></p>
    </main>
  );
}
