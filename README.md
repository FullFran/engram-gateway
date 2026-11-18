# engram-gateway

Serve [Engram](https://github.com/Gentleman-Programming/engram)'s memory as a
remote MCP server: `engram mcp` (stdio) exposed over Streamable HTTP at `/mcp`,
behind an OAuth 2.1 authorization server that signs people in with GitHub.

Use it to share one Engram memory between agents that cannot run the binary
next to it: ChatGPT and Claude connectors, an agent in a container, a second
machine.

```text
MCP client ──HTTPS──> engram-gateway ──stdio──> engram mcp ──> SQLite (volume)
             OAuth 2.1 (GitHub sign-in)
```

## How it works

- **Bridge.** One long-lived `engram mcp` child process. Every MCP session on
  `/mcp` gets a server that forwards `tools/list` and `tools/call` to it
  verbatim (schemas, `isError`, `structuredContent`). If the child dies, the
  next request restarts it. Both the 2026-07-28 protocol and the legacy
  `initialize` handshake are served.
- **Tool-call pipeline.** Every `tools/call` runs through the same stages,
  in order: authorize → redact → forward to Engram → audit → wrap result.
  Authorize and audit are pass-through placeholders for now (roles and
  grants, audit log).
- **Secret redaction.** Before a tool call is forwarded, every string
  argument (values and object keys) is scanned for well-known secret shapes
  and each match becomes `[secret removed:<kind>]`: Anthropic, OpenAI,
  GitHub, AWS access and secret keys, Stripe, Slack, Google API keys, npm
  tokens, JWTs, PEM private keys (also without an `END` line), `Bearer`
  tokens, passwords in URLs, and `.env`-style assignments such as
  `API_KEY=...` or `password: ...`. Invisible characters (zero-width spaces
  and the like) are ignored when matching. This is default deny: every tool
  is redacted except read-only tools whose arguments are never stored
  (`mem_search`, `mem_context`, `mem_get_observation`, ...), so tools Engram
  adds later are covered. Only per-kind counts are kept for the audit step;
  the matched text is never logged. There are no entropy heuristics, so git
  SHAs and UUIDs survive. Redaction is on by default and has no environment
  switch.

  Limits: it is pattern based. Secrets that are encoded (base64,
  URL-encoding), split across fields or lines, written as prose ("the
  password is ..."), or in a shape not listed above still reach Engram.
  Text stored before this feature is not rewritten.
- **Auth.** A built-in OAuth 2.1 authorization server: protected resource
  metadata (RFC 9728), dynamic client registration, client ID metadata
  documents, PKCE, rotating refresh tokens. People sign in with GitHub's
  device flow, so only the OAuth App's public client ID is needed. Only the
  logins in `ALLOWED_GITHUB_LOGINS` get a token. The token scope is `memory`.
- **Engram.** The Docker image ships one pinned Engram release
  (`engram.version`), verified against the release's `checksums.txt`. A
  scheduled workflow opens a PR when Engram publishes a new release, after
  the e2e suite passes against it.

## Deploy

1. Create a GitHub OAuth App (Settings → Developer settings → OAuth Apps)
   and tick **Enable Device Flow**. The callback URL is not used; put your
   public URL. Copy the client ID. No client secret is needed.
2. Deploy `compose.dokploy.yml` (Dokploy, or any Docker host with a TLS
   reverse proxy in front of port 3000) with:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `PUBLIC_BASE_URL` | yes | Public HTTPS origin, e.g. `https://memory.example.com` |
   | `GITHUB_CLIENT_ID` | yes | The OAuth App's client ID |
   | `ALLOWED_GITHUB_LOGINS` | yes | Comma-separated GitHub logins allowed in |
   | `GITHUB_APP_NAME` | no | Name shown on the sign-in page |
   | `ENGRAM_PROJECT` | no | Default Engram project for this memory |
   | `ENGRAM_CLOUD_SERVER`, `ENGRAM_CLOUD_TOKEN`, `ENGRAM_CLOUD_AUTOSYNC` | no | Passed to `engram`, for Engram Cloud sync |

   State lives in the `/data` volume: `/data/engram` (Engram's database) and
   `/data/gateway` (clients, tokens and the session-signing secret, which is
   generated on first start with mode 0600).
3. Add `https://<your-host>/mcp` as a remote MCP server in your client and
   sign in with GitHub when asked.

### Other settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Bind address |
| `AUTH_MODE` | off on loopback, `oauth` otherwise | `off` on a non-loopback bind also needs `ALLOW_INSECURE_NO_AUTH=true` |
| `TRUST_PROXY` | unset | Express `trust proxy` (set `1` behind one reverse proxy) |
| `ENGRAM_BIN` | `engram` | Engram binary |
| `ENGRAM_ARGS` | `mcp` | Arguments for the child, e.g. `mcp --tools=agent` |
| `ENGRAM_DATA_DIR` | Engram's default | Engram's data directory |
| `GATEWAY_DATA_DIR` | required when auth is on | Auth state directory (the image sets `/data/gateway`) |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_TOKEN_TTL_SECONDS`, `AUTH_SESSION_TTL_SECONDS` | 1 h, 30 d, 7 d | Token and sign-in session lifetimes |
| `GITHUB_CLIENT_SECRET` / `GITHUB_CLIENT_SECRET_FILE` | unset | Only for the web (redirect) flow instead of device flow |

## Develop

```sh
npm ci
npm run build
npm run test:unit        # unit tests, no network
ENGRAM_BIN=$(command -v engram) npm test   # plus e2e against a real engram
```

The e2e scripts run Engram in throwaway `HOME` and data directories and strip
every `ENGRAM_CLOUD_*` variable, so they never sync to your Engram Cloud.

## Credits

The authorization server is ported from
[pizarra](https://github.com/FullFran/pizarra) (same author, MIT).

## License

MIT
