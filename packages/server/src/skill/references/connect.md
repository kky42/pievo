# Connect a machine

Use the **pievo-cli** command prefix supplied by the user; otherwise use `pievo`.
A first-capture snippet supplies a **server-url** and one-time **connect-key**. Use
both verbatim.

If no custom command prefix was supplied, install the current CLI:

```bash
npm install -g @kky42/pievo@latest
```

Start the daemon:

```bash
<pievo-cli> daemon start --server-url <server-url> --connect-key <connect-key>
```

The command is idempotent: it reuses this machine's identity, starts one detached
daemon if needed, and waits for the server to see it online. It exits successfully
with `daemon online …` or `daemon already running …`. If it cannot connect, follow
the printed log path rather than guessing credentials or server settings.

Once connected, continue with `create.md` when the user wants a new loop. Existing
connections normally need no server URL or key on later `pievo` commands.
