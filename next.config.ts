import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // These parse HTML at runtime and load parts of themselves dynamically,
  // so they are left out of the bundle and loaded from node_modules.
  serverExternalPackages: ['linkedom', '@mozilla/readability', 'turndown', 'turndown-plugin-gfm', 'undici'],
  poweredByHeader: false,
};

export default nextConfig;
