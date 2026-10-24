import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

/**
 * Compares a presented secret with the expected one in constant time. Both sides
 * are hashed first, so the comparison reveals neither the value nor its length.
 */
export function sameSecret(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || !expected) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

const localOrPrivate = new BlockList();
for (const [ip, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
] as const)
  localOrPrivate.addSubnet(ip, prefix, 'ipv4');
localOrPrivate.addAddress('::1', 'ipv6');
localOrPrivate.addSubnet('fc00::', 7, 'ipv6');
localOrPrivate.addSubnet('fe80::', 10, 'ipv6');

/**
 * True for loopback, private and link-local addresses: the peers a reverse proxy
 * on this host or in the Compose network connects from.
 */
export function isLocalOrPrivateAddress(address: string): boolean {
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  const family = isIP(bare);
  if (family === 4) return localOrPrivate.check(bare, 'ipv4');
  if (family === 6) return localOrPrivate.check(bare, 'ipv6');
  return false;
}
