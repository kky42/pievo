/** User-facing daemon commands. Public UX installs globally; PIEVO_CLI dev
 * overrides are invoked verbatim and never trigger a global npm install. */
export function daemonConnectCommand(origin: string, token: string, cli: string, customCli: boolean): string {
  const start = `${cli} daemon start --server-url ${origin} --connect-key ${token}`
  return customCli ? start : `npm install -g @kky42/pievo@latest && ${start}`
}

export function daemonUpgradeCommand(cli: string, customCli: boolean): string {
  const restart = `${cli} daemon restart`
  return customCli ? restart : `npm install -g @kky42/pievo@latest && ${restart}`
}
