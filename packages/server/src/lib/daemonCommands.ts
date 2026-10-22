/** User-facing daemon commands. Public UX installs globally; PIEVO_CLI dev
 * overrides are invoked verbatim and never trigger a global npm install. */
export function daemonConnectCommand(origin: string, token: string, cli: string, customCli: boolean): string {
  const start = `${cli} daemon connect --server-url ${origin} --connect-key ${token}`
  return customCli ? start : `npm install -g @kky42/pievo@latest && ${start}`
}

/** The server URL other devices should use. A dashboard opened on the server
 * itself sees a loopback origin, which no other device can reach, so prefer the
 * launcher-published network URL there. */
export function connectServerUrl(origin: string, publicUrl: string | null): string {
  if (!publicUrl) return origin
  try {
    const host = new URL(origin).hostname
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.') ? publicUrl : origin
  } catch {
    return publicUrl
  }
}

export function daemonUpgradeCommand(cli: string, customCli: boolean): string {
  const restart = `${cli} daemon restart`
  return customCli ? restart : `npm install -g @kky42/pievo@latest && ${restart}`
}
