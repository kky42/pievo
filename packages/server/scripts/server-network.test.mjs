import { expect, test } from "vitest";

import { currentHttpsUrl, disableHttps, enableHttps, lanAddresses, reachableUrls, tailscaleInfo } from "./server-network.mjs";

const DNS = "box.tail1.ts.net";
const status = { BackendState: "Running", Self: { DNSName: `${DNS}.`, TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"] }, CertDomains: [DNS] };

/** A fake `tailscale` CLI whose serve config is mutable state. */
function fakeTailscale({ serve = {}, serveFails } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    if (file !== "tailscale") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (args[0] === "version") return "1.0.0\n";
    if (args[0] === "status") return JSON.stringify(status);
    if (args[0] === "serve" && args[1] === "status") return JSON.stringify(serve);
    if (args[0] === "serve" && args.at(-1) === "off") {
      serve = {};
      return "";
    }
    if (args[0] === "serve") {
      if (serveFails) throw Object.assign(new Error("exit 1"), { stdout: serveFails, stderr: "" });
      serve = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: args.at(-1) } } } } };
      return "";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { exec, calls, serve: () => serve };
}

test("reads this device's Tailscale name and IPv4", () => {
  expect(tailscaleInfo(fakeTailscale().exec)).toEqual({ cli: "tailscale", dnsName: DNS, ipv4: "100.64.1.2", httpsAvailable: true });
  expect(tailscaleInfo(() => { throw new Error("missing"); })).toBeUndefined();
});

test("publishes HTTPS for the server port and retracts only its own mapping", () => {
  const ts = fakeTailscale();
  const info = tailscaleInfo(ts.exec);
  expect(enableHttps(info, 3000, ts.exec)).toEqual({ ok: true, url: `https://${DNS}` });
  expect(ts.calls).toContainEqual(["tailscale", "serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3000"]);
  expect(currentHttpsUrl(info, 3000, ts.exec)).toBe(`https://${DNS}`);
  expect(enableHttps(info, 3000, ts.exec)).toEqual({ ok: true, url: `https://${DNS}` });

  expect(disableHttps(info, 4000, ts.exec)).toBe(false);
  expect(disableHttps(info, 3000, ts.exec)).toBe(true);
  expect(ts.serve()).toEqual({});
});

test("never replaces an HTTPS mapping that serves something else", () => {
  const other = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } } };
  const ts = fakeTailscale({ serve: other });
  const result = enableHttps(tailscaleInfo(ts.exec), 3000, ts.exec);
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/already serving http:\/\/127\.0\.0\.1:8080/);
  expect(ts.serve()).toBe(other);
});

test("surfaces the approval link when Serve is not enabled on the tailnet", () => {
  const ts = fakeTailscale({ serveFails: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n" });
  const result = enableHttps(tailscaleInfo(ts.exec), 3000, ts.exec);
  expect(result).toEqual({ ok: false, reason: expect.stringContaining("https://login.tailscale.com/f/serve?node=abc") });
});

test("lists private LAN IPv4 addresses only", () => {
  expect(lanAddresses({
    lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.5" }, { family: "IPv6", internal: false, address: "fe80::1" }],
    utun4: [{ family: "IPv4", internal: false, address: "100.64.1.2" }],
    en5: [{ family: "IPv4", internal: false, address: "203.0.113.9" }],
  })).toEqual(["192.168.1.5"]);
});

test("prefers HTTPS, then Tailscale, then LAN for the connect URL", () => {
  const tailscale = { dnsName: DNS, ipv4: "100.64.1.2" };
  const all = reachableUrls({ host: "0.0.0.0", port: 3000, https: `https://${DNS}`, tailscale, lan: ["192.168.1.5"] });
  expect(all).toEqual({
    local: "http://127.0.0.1:3000",
    lan: ["http://192.168.1.5:3000"],
    tailscale: [`http://${DNS}:3000`, "http://100.64.1.2:3000"],
    https: `https://${DNS}`,
    connect: `https://${DNS}`,
  });
  expect(reachableUrls({ host: "0.0.0.0", port: 3000, tailscale, lan: ["192.168.1.5"] }).connect).toBe(`http://${DNS}:3000`);
  expect(reachableUrls({ host: "0.0.0.0", port: 3000, lan: ["192.168.1.5"] }).connect).toBe("http://192.168.1.5:3000");
  expect(reachableUrls({ host: "127.0.0.1", port: 3000, tailscale, lan: ["192.168.1.5"] }))
    .toMatchObject({ lan: [], tailscale: [], connect: "http://127.0.0.1:3000" });
});
