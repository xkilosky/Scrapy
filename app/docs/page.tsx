/**
 * The docs, for anybody: no login, on every Scrapy. The same two pages are in
 * the dashboard's menu, for the owner who is already there.
 */
import type { Metadata } from 'next';
import { DocsPage } from '../ui/DocsPage';

export const metadata: Metadata = { title: 'Docs · Scrapy' };

export default function Page() {
  return <DocsPage />;
}
