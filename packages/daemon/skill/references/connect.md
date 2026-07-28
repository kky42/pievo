# Connect a machine

Use the Pievo command prefix supplied by the user; otherwise use `pievo`. A dashboard
connection command supplies a server URL and connect key. Reuse both verbatim, never
print the key unnecessarily, and never guess replacement credentials.

If the default CLI is unavailable, install the current release:

```bash
npm install -g @kky42/pievo@latest
```

Consult the installed command contract, then connect:

```bash
<pievo-cli> daemon connect --help
<pievo-cli> daemon connect --server-url <server-url> --connect-key <connect-key>
```

Follow the command's status and printed log path if it cannot reach the server. Once
online, continue with `create.md` if the user wants a loop. Saved connections normally
supply later owner commands with their server and device identity.
