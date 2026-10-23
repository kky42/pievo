# Connect a machine

The dashboard's connect command supplies a server URL and a connect key. Reuse both
exactly as given. Treat the key as a secret: don't print it again, and never invent
one.

If `pievo` is not installed, run `npm install -g @kky42/pievo@latest`.

```bash
<pievo-cli> daemon connect --help
<pievo-cli> daemon connect --server-url <server-url> --connect-key <connect-key>
```

If it can't reach the server, follow the status and log path the command prints.
Later commands reuse the saved connection. Continue with `create.md` if the owner
wants a loop.
