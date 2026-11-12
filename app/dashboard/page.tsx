/**
 * The dashboard: checks, the address and the key for an agent, a tool to try,
 * the live feed, and the docs.
 *
 * Where Scrapy is personal, this page is for its owner. A browser that is not
 * logged in is sent to the login page before anything is shown. The part of
 * the dashboard that was asked for ("#logs") travels along, so the owner lands
 * on it after logging in.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Console from '../ui/Console';
import { viewer } from '../ui/viewer';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard · Scrapy' };

export default async function DashboardPage() {
  const who = await viewer();
  if (who.state === 'personal' && !who.loggedIn) redirect('/login');
  return <Console />;
}
