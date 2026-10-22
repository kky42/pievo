import { isIP } from "node:net";

/**
 * Pievo has no login, so the network is the access boundary: only this
 * machine, private LAN ranges, and Tailscale peers may reach any route.
 * Anyone who passes this check can run prompts on every connected machine.
 * Requests proxied by `tailscale serve` arrive from loopback.
 *
 * IPv4: loopback 127/8, RFC 1918 (10/8, 172.16/12, 192.168/16), link-local
 * 169.254/16, and CGNAT 100.64/10 (Tailscale addresses). IPv6: loopback,
 * link-local fe80::/10, and unique-local fc00::/7 (includes Tailscale's
 * fd7a:115c:a1e0::/48). IPv4-mapped IPv6 is checked as IPv4.
 */
export function isTrustedPeer(address: string | undefined | null): boolean {
  if (!address) return false;
  const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "").split("%")[0]!;
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 127
      || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    if (ip === "::1") return true;
    const first = parseInt(ip.split(":")[0] || "0", 16);
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
  }
  return false;
}
