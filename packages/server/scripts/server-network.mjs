import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

// The launcher (never request handling) shells out to the local Tailscale CLI.
// A bounded timeout matters: `tailscale serve` blocks waiting for an admin
// approval when Serve is not yet enabled on the tailnet.
const TAILSCALE_TIMEOUT_MS = 15_000;
const HTTPS_PORT = 443;
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function defaultExec(file, args) {
  return execFileSync(file, args, {
    encoding: "utf8",
    timeout: TAILSCALE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tailscaleCli(exec) {
  for (const candidate of ["tailscale", MAC_APP_CLI]) {
    if (candidate.startsWith("/") && !fs.existsSync(candidate)) continue;
    try {
      exec(candidate, ["version"]);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** This device's Tailscale identity, or undefined when Tailscale is absent or down. */
export function tailscaleInfo(exec = defaultExec) {
  const cli = tailscaleCli(exec);
  if (!cli) return undefined;
  try {
    const status = JSON.parse(exec(cli, ["status", "--json"]));
    if (status.BackendState !== "Running") return undefined;
    const dnsName = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
    const ipv4 = (status.Self?.TailscaleIPs ?? []).find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (!dnsName && !ipv4) return undefined;
    return { cli, dnsName: dnsName || undefined, ipv4, httpsAvailable: (status.CertDomains ?? []).length > 0 };
  } catch {
    return undefined;
  }
}

function serveStatus(info, exec) {
  try {
    return JSON.parse(exec(info.cli, ["serve", "status", "--json"]) || "{}");
  } catch {
    return undefined;
  }
}

function httpsProxyTarget(serve, dnsName) {
  return serve?.Web?.[`${dnsName}:${HTTPS_PORT}`]?.Handlers?.["/"]?.Proxy;
}

function localTarget(port) {
  return `http://127.0.0.1:${port}`;
}

/** The Tailscale HTTPS URL currently proxying to this port, if any. */
export function currentHttpsUrl(info, port, exec = defaultExec) {
  if (!info?.dnsName) return undefined;
  return httpsProxyTarget(serveStatus(info, exec), info.dnsName) === localTarget(port)
    ? `https://${info.dnsName}`
    : undefined;
}

/**
 * Point `https://<device>.ts.net` at the local server via `tailscale serve`.
 * Never replaces an HTTPS mapping that proxies somewhere else.
 */
export function enableHttps(info, port, exec = defaultExec) {
  if (!info?.dnsName) return { ok: false, reason: "Tailscale is not running" };
  const serve = serveStatus(info, exec);
  if (!serve) return { ok: false, reason: "could not read the Tailscale Serve configuration" };
  const existing = httpsProxyTarget(serve, info.dnsName);
  if (existing === localTarget(port)) return { ok: true, url: `https://${info.dnsName}` };
  if (existing || serve.TCP?.[String(HTTPS_PORT)]) {
    return { ok: false, reason: `Tailscale HTTPS port ${HTTPS_PORT} is already serving ${existing ?? "another target"}` };
  }
  try {
    exec(info.cli, ["serve", "--bg", "--yes", `--https=${HTTPS_PORT}`, localTarget(port)]);
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    const enableUrl = output.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
    return {
      ok: false,
      reason: enableUrl
        ? `Tailscale Serve is not enabled on this tailnet; approve it at ${enableUrl}, then restart`
        : "tailscale serve failed",
    };
  }
  return currentHttpsUrl(info, port, exec)
    ? { ok: true, url: `https://${info.dnsName}` }
    : { ok: false, reason: "tailscale serve did not apply the HTTPS mapping" };
}

/** Remove the HTTPS mapping only when it still points at this server's port. */
export function disableHttps(info, port, exec = defaultExec) {
  if (!currentHttpsUrl(info, port, exec)) return false;
  try {
    exec(info.cli, ["serve", `--https=${HTTPS_PORT}`, "off"]);
    return true;
  } catch {
    return false;
  }
}

function privateIpv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Non-loopback private IPv4 addresses on this machine's LAN interfaces. */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && privateIpv4(entry.address)) out.push(entry.address);
    }
  }
  return [...new Set(out)];
}

/**
 * Every URL the server can be reached at, best first. `connect` is the URL other
 * devices should use (HTTPS, then Tailscale name, then LAN address).
 */
export function reachableUrls({ host, port, https, tailscale, lan = lanAddresses() }) {
  const allInterfaces = host === "0.0.0.0" || host === "::";
  const local = `http://${allInterfaces || host === "localhost" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host}:${port}`;
  if (!allInterfaces) return { local, lan: [], tailscale: [], https, connect: https ?? local };
  const tailscaleUrls = [tailscale?.dnsName, tailscale?.ipv4].filter(Boolean).map((name) => `http://${name}:${port}`);
  const lanUrls = lan.map((ip) => `http://${ip}:${port}`);
  return { local, lan: lanUrls, tailscale: tailscaleUrls, https, connect: https ?? tailscaleUrls[0] ?? lanUrls[0] };
}
