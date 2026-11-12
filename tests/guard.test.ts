import { describe, expect, it } from 'vitest';
import { ScrapyError } from '../lib/errors';
import { checkPublicUrl, isPrivateHostname, isPrivateIp, parseIPv6, resolvePublicHost } from '../lib/guard';

describe('isPrivateIp', () => {
  it('knows private, local and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.5', '198.18.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '2001:db8::1', '2002:7f00:1::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('lets public addresses through', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('treats unreadable text as private', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(parseIPv6('1:2:3')).toBeNull();
    expect(parseIPv6('::1::2')).toBeNull();
  });
});

describe('isPrivateHostname', () => {
  it('refuses internal names', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'router', 'intranet', 'nas.lan', 'x.home.arpa', 'site.test', '[::1]', '127.0.0.1']) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
  });

  it('accepts public names', () => {
    for (const host of ['example.com', 'docs.example.co.uk', 'localhost.example.com', 'internal-tools.example.com', '8.8.8.8', '[2606:4700:4700::1111]']) {
      expect(isPrivateHostname(host), host).toBe(false);
    }
  });
});

describe('checkPublicUrl', () => {
  const reason = (input: string): string => {
    try {
      checkPublicUrl(input);
      return 'accepted';
    } catch (err) {
      return err instanceof ScrapyError ? err.reason : 'other';
    }
  };

  it('accepts web links and adds a missing https://', () => {
    expect(checkPublicUrl('https://example.com/a?b=1').href).toBe('https://example.com/a?b=1');
    expect(checkPublicUrl('example.com/docs').href).toBe('https://example.com/docs');
    expect(checkPublicUrl('  http://example.com  ').href).toBe('http://example.com/');
    expect(checkPublicUrl('example.com:8080/x').href).toBe('https://example.com:8080/x');
  });

  it('drops a plain #section but keeps a #/route', () => {
    expect(checkPublicUrl('https://example.com/page#install').href).toBe('https://example.com/page');
    expect(checkPublicUrl('https://example.com/#/settings').href).toBe('https://example.com/#/settings');
  });

  it('refuses private and internal addresses, however they are written', () => {
    for (const link of [
      'http://localhost:3000/',
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f.0.0.1/',
      'http://017700000001/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin',
      'http://192.168.0.1/',
      'https://intranet/',
      'https://db.internal/',
    ]) {
      expect(reason(link), link).toBe('private_address');
    }
  });

  it('refuses things that are not web links', () => {
    for (const link of ['', 'ftp://example.com/file', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com/', 'x'.repeat(2_100)]) {
      expect(reason(link), link.slice(0, 40)).toBe('bad_input');
    }
  });
});

describe('resolvePublicHost', () => {
  it('refuses a public-looking name that points to a private address', async () => {
    await expect(resolvePublicHost('sneaky.example.com', async () => ['10.0.0.7'])).rejects.toMatchObject({ reason: 'private_address' });
    await expect(resolvePublicHost('mixed.example.com', async () => ['93.184.216.34', '127.0.0.1'])).rejects.toMatchObject({ reason: 'private_address' });
  });

  it('returns the addresses of a public name', async () => {
    await expect(resolvePublicHost('example.com', async () => ['93.184.216.34'])).resolves.toEqual(['93.184.216.34']);
  });

  it('says so when a name does not exist', async () => {
    await expect(
      resolvePublicHost('nope.example.com', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });
});
