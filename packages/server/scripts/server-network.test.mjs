import { expect, test } from "vitest";

import { currentHttpsUrl, disableHttps, enableHttps, tailscaleInfo } from "./server-network.mjs";

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
