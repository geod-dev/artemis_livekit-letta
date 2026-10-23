/** Fetch a public web page for its link preview, refusing private destinations. */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { type LinkMetadata, linkMetadata } from './link-description';

const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');

function isPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && /^[23]/.test(address) && !blocked.check(address, 'ipv6');
}

async function readPage(url: URL, signal: AbortSignal, redirects = 0): Promise<string> {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== '80' && url.port !== '443')
  )
    throw new Error('Unsupported URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublic(address)))
    throw new Error('Private destination');
  signal.throwIfAborted();
  // Pin the validated address so DNS cannot change between validation and connection.
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        family: address.family,
        headers: {
          Accept: 'text/html',
          'Accept-Encoding': 'identity',
          'User-Agent': 'LinkPreview/1.0',
        },
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.destroy();
          if (redirects >= 3) {
            reject(new Error('Too many redirects'));
            return;
          }
          try {
            resolve(readPage(new URL(response.headers.location, url), signal, redirects + 1));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (status !== 200 || !response.headers['content-type']?.includes('text/html')) {
          response.destroy();
          reject(new Error('No HTML preview'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) {
            response.destroy();
            resolve(Buffer.concat(chunks).toString('utf8'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.end();
  });
}

/** The title and description of a public page (5 s budget). */
export async function linkPreview(href: string): Promise<LinkMetadata> {
  return linkMetadata(await readPage(new URL(href), AbortSignal.timeout(5000)));
}
