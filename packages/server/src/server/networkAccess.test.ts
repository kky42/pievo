import { expect, test } from "vitest";

import { isTrustedPeer } from "./networkAccess.js";

test.each([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.20",
  "::ffff:192.168.1.20",
  "169.254.10.1",
  "100.64.0.1",
  "100.110.126.26",
  "100.127.255.255",
  "fd7a:115c:a1e0::1",
  "fe80::1%en0",
])("allows local, LAN, and Tailscale peer %s", (address) => {
  expect(isTrustedPeer(address)).toBe(true);
});

test.each([
  undefined,
  "",
  "8.8.8.8",
  "172.32.0.1",
  "100.128.0.1",
  "::ffff:8.8.8.8",
  "2001:4860:4860::8888",
  "not-an-ip",
])("rejects public or unknown peer %s", (address) => {
  expect(isTrustedPeer(address)).toBe(false);
});
