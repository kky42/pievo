# @kky42/pievo

The CLI for [Pievo](https://github.com/kky42/pievo): run stored coding-agent prompts
(Claude Code, Codex, or Pi) on a reliable schedule across your own devices.
`pievo server` hosts the dashboard and scheduler on one device; `pievo daemon` runs
loops on every device that executes them.

```bash
npm install -g @kky42/pievo@latest
pievo server start                                        # on the dashboard device
pievo daemon connect --server-url <url> --connect-key <dk_…>   # on each loop device
```

Requires Node.js `>=22.13` (`>=22.19` for Pi). The daemon launches coding agents
unattended with the files, commands, and credentials available to it; start with a
disposable project or restrict it with `PIEVO_ROOTS`.

Setup, network access, commands, and security controls are documented in the
[project README](https://github.com/kky42/pievo#readme).

## License

[MIT](LICENSE)
