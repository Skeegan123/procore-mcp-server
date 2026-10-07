# Hosting the Procore MCP server for your team

This guide covers everything needed to turn the local, single-user MCP server into a
hosted service that any teammate can use from Claude, ChatGPT (Business/Enterprise),
Codex, or any MCP client — signing in with **their own** Procore account.

Do these steps in order. Nothing here requires writing code.

---

## 1. How hosted mode works (5-minute overview)

`npm run start:http` starts an HTTP server that exposes:

| Endpoint | Purpose |
| --- | --- |
| `/mcp` | The MCP endpoint itself (Bearer token required) |
| `/oauth/authorize` | Starts sign-in: redirects the user to Procore's own login page |
| `/oauth/callback` | Procore redirects back here after login |
| `/oauth/token` | Exchanges a one-time code for an access token |
| `/.well-known/oauth-protected-resource` | Discovery so clients know how to authenticate |
| `/.well-known/oauth-authorization-server` | OAuth metadata |
| `/healthz` | Liveness check for hosting platforms |

The flow, end to end:

1. A user's MCP client asks them to sign in and opens `/oauth/authorize`.
2. The server redirects the browser to **Procore's real login page**. The user types
   their own Procore username/password there — Procore never shares the password with
   this server.
3. Procore redirects back to `/oauth/callback` with a one-time code. The server swaps
   that code for the user's Procore API tokens and stores them in a per-user file.
4. The server hands the client its own short-lived access token (signed, self-verifying).
5. Every subsequent MCP call carries that token; the server looks up *that user's*
   Procore tokens and makes the Procore request as them.

Key properties to remember:

- **No shared service account.** Every query runs against Procore as the signed-in
  user, so Procore's own permissions decide what each person can see.
- **Read-only stays on by default.** While `PROCORE_READ_ONLY=true`, only GET requests
  are served even in hosted mode.
- **Stateless requests.** No sessions are stored between calls, so you can restart,
  upgrade, or load-balance without users noticing.

---

## 2. Test everything locally before paying for anything

### 2.1 Prerequisites

- Node.js 20+
- A **sandbox** Procore app in the [Developer Portal](https://developers.procore.com/)
  (use sandbox while testing; see the repo guidelines)

#### Getting credentials from the Developer Portal (the confusing part, explained)

The new App Management portal gates OAuth credentials behind app configuration.
What you'll see and what to do about it:

- The **OAuth Credentials** section shows empty Client ID / Secret fields with a
  banner: *"Promote Your App to View OAuth Credentials — your app must include a
  data connector component and be promoted to the production environment."*
  Credentials are not issued for apps that have no components.
- The **Sandbox OAuth Credentials** section may show only a **Sandbox URL** field
  (plus an Update button) and no credentials. A sandbox URL alone does not
  generate credentials.

The unblock sequence, in order:

1. **Fill in the Sandbox URL** in the sandbox section (your sandbox company URL,
   e.g. `https://sandbox.procore.com/<company_id>/company/home`) and click
   **Update**. If credentials appear now, you're done — skip the rest.
2. **Add a Data Connector component**: Configuration Builder → Data Connector
   Components → Add Component → select **User Level Authentication** (users sign
   in as themselves — our model; skip Service Account Authentication, that's for
   server-to-server crawlers). Save the component.
3. **Create an app version** so the component is actually in a version
   (Versions → create new). Check OAuth Credentials again.
4. **Promote the version to production** (Versions → Promote) if credentials
   still haven't appeared. Production credentials are revealed at promotion time
   and **the client secret is shown only once — save it immediately**. You'll
   need production credentials for real hosting anyway; until then keep testing
   with `PROCORE_ENV=sandbox` if sandbox credentials were issued, or test
   carefully against production in read-only mode.

Register `http://localhost/oauth/callback` as a redirect URI wherever the portal
accepts one (`http://localhost` is the only non-HTTPS URI Procore allows, which is
why the local server listens on port 80; macOS doesn't require special
permissions for this).

The number in the sandbox URL is your sandbox **company ID** — keep it handy as
`PROCORE_COMPANY_ID` so `procore_api_call` can default the `Procore-Company-Id`
header.

> If credentials still don't appear after step 4, contact Procore developer
> support — the portal has changed several times and account-level provisioning
> issues (e.g. the Developer Sandbox itself) do happen.

### 2.2 Configure

Create or extend `.env` in the project root:

```bash
PROCORE_CLIENT_ID=<your sandbox client id>
PROCORE_CLIENT_SECRET=<your sandbox client secret>
PROCORE_ENV=sandbox
PROCORE_READ_ONLY=true

PROCORE_MCP_BASE_URL=http://localhost
PROCORE_MCP_TOKEN_SECRET=<paste output of the command below>
PROCORE_OAUTH_REDIRECT_URIS=http://localhost/oauth/callback
```

Generate the token-signing secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2.3 Build and run the test suite

```bash
npm ci
npm run build
npm test
```

All tests must pass before moving on.

### 2.4 Start the server

```bash
npm run start:http
```

You should see:

```
Procore MCP HTTP server listening on port 80
MCP endpoint: http://localhost/mcp
Read-only mode is ON — every served tool call is a GET.
```

Leave it running in this terminal. Check `http://localhost/healthz` in a browser — it
should return JSON like `{"ok":true,"read_only":true}`.

> **Port gotcha:** the server's default port is 8787, but the local Procore OAuth
> flow only works on port 80 — Procore accepts plain `http://localhost` (no port)
> as a redirect URI, and the redirect URI registered in the portal must match the
> one the server sends during token exchange character-for-character. Always start
> with `PORT=80 npm run start:http` and keep `PROCORE_MCP_BASE_URL=http://localhost`.
> If the startup log says "listening on port 8787", the PORT variable didn't take.
> (You can experiment with `http://localhost:8787/oauth/callback` if Procore's
> portal accepts it, but the portless setup is the known-good path.)

### 2.5 Walk the sign-in flow manually

This simulates exactly what ChatGPT or Claude will do automatically.

**Step 1 — generate a PKCE pair** (think of it as a one-time handshake secret):

```bash
node -e "const c=require('crypto');const v=c.randomBytes(48).toString('base64url');console.log('VERIFIER:',v,'\nCHALLENGE:',c.createHash('sha256').update(v).digest('base64url'))"
```

Keep both values handy.

**Step 2 — open the authorization URL in your browser**, replacing `CHALLENGE`
with the challenge value from step 1:

```
http://localhost/oauth/authorize?response_type=code&client_id=localtest&redirect_uri=http://localhost/oauth/callback&code_challenge=CHALLENGE&code_challenge_method=S256&state=test123
```

You will land on Procore's sandbox login. Sign in **as yourself**.

**Step 3 — capture the code.** After login the browser lands on a URL like:

```
http://localhost/oauth/callback?code=SOME_CODE&state=test123
```

(The page will show an error — that's expected, nothing consumes the browser redirect
during a manual test. Copy the `code` value from the address bar.)

**Step 4 — exchange the code for an access token:**

```bash
curl -s -X POST http://localhost/oauth/token \
  -d grant_type=authorization_code \
  -d code=PASTE_CODE_HERE \
  -d redirect_uri=http://localhost/oauth/callback \
  --data-urlencode code_verifier=PASTE_VERIFIER_HERE
```

Response: `{"access_token":"...","token_type":"Bearer","expires_in":2592000}`

**Step 5 — prove it works as YOUR account.**

```bash
TOKEN=paste_access_token_here

# List available tools
curl -s -X POST http://localhost/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Make a real read-only call against Procore as yourself
curl -s -X POST http://localhost/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"procore_api_call","arguments":{"method":"GET","path":"/rest/v1.0/me"}}}'
```

`/rest/v1.0/me` returns your own Procore profile — proof the call ran as your user,
not a shared account. Also check that `~/.procore-mcp/users/` now contains one token
file (its name is a hash, not your email).

### 2.6 Negative tests (should all FAIL politely)

| Try | Expect |
| --- | --- |
| Replay step 4 with the same `code` | `invalid_grant` error |
| Call `/mcp` with no `Authorization` header | HTTP 401 with a `WWW-Authenticate` header |
| Call `/mcp` with a made-up token | HTTP 401 |
| Open `/oauth/authorize` with `redirect_uri=https://evil.example/cb` | HTTP 400 |
| Change the `code_verifier` when exchanging | `invalid_grant` error |

### 2.7 Optional: try a real MCP client

```bash
claude mcp add --transport http procore http://localhost/mcp
```

Claude Code will drive the whole OAuth flow itself — you'll just see a browser window
asking you to log in to Procore. This previews exactly what teammates will experience.

---

## 3. Putting it on the internet (when you're ready)

ChatGPT web connectors require a public **HTTPS** URL, so the local server needs a
home. Two stages:

### Stage A — quick tunnel (test the real ChatGPT UI from your laptop)

Tools like [ngrok](https://ngrok.com/) or Cloudflare Tunnel give your local machine a
temporary public HTTPS URL:

```bash
ngrok http 80        # prints something like https://abc123.ngrok.app
```

Then:

1. Set `PROCORE_MCP_BASE_URL=https://abc123.ngrok.app` in `.env` and restart.
2. In the Procore Developer Portal app, also add
   `https://abc123.ngrok.app/oauth/callback` as a redirect URI.
3. Add `https://chatgpt.com/connector_platform_oauth_redirect` to
   `PROCORE_OAUTH_REDIRECT_URIS` and restart.
4. In ChatGPT (Business workspace): Workspace settings → Apps → enable developer
   mode → create connector → paste `https://abc123.ngrok.app/mcp` → complete OAuth →
   test in a chat.

The URL dies when you stop ngrok — good enough to validate, not to share.

### Stage B — a real always-on home ("the Dockerfile thing")

**What a container actually is:** your app plus the exact version of Node it needs,
frozen into a single portable image. A `Dockerfile` is just the recipe listing those
steps (copy files, install dependencies). Any host that runs containers — Fly.io,
Railway, Render, AWS, Google Cloud — will produce identical results, which removes
"works on my machine" from the equation. It's the standard way to deploy small
services, and the recipe below is all there is to it.

When ready, create a `Dockerfile` in the project root:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY data ./data
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/src/http-server.js"]
```

And a `.dockerignore`: `node_modules`, `.env`, `.git`, `specs`.

What deployment then looks like (Fly.io shown; Railway/Render are click-through
equivalents):

1. Push the repo with the Dockerfile to a fresh private GitHub repo.
2. Create the app on the platform and point it at the repo — it builds the image.
3. Attach a small persistent volume mounted at `/data`.
4. Set environment variables in the platform dashboard (same ones as `.env`, plus
   `PORT=8080`, `PROCORE_USER_TOKEN_DIR=/data/users`,
   `PROCORE_MCP_BASE_URL=https://your-app.fly.dev`).
5. Add `https://your-app.fly.dev/oauth/callback` to the Procore app's redirect URIs
   (and keep the ChatGPT redirect URI in `PROCORE_OAUTH_REDIRECT_URIS`).
6. Publish the connector in ChatGPT workspace settings so everyone gets it without
   doing any setup.

Costs at "a few users, not hammering it" scale: roughly free (Fly.io allowance) to
about $5/month (smallest paid tiers).

---

## 4. Security model, honestly stated

What protects user tokens (`src/auth/user-token-store.ts`):

- One file per user, hashed filenames (no path traversal, no PII)
- Written `0600` into a `0700` directory via atomic rename
- Per-user scoping: a leak exposes one person's access, never a god-mode account
- Refresh-token rotation handled on every refresh

What protects sign-in:

- PKCE (S256) mandatory; single-use grants that burn on ANY failed attempt
- Redirect URI allowlist — the server refuses unknown callbacks
- The Procore client secret lives only on the server; browsers only ever see
  `client_id`
- Access tokens are HMAC-signed with an expiry and carry no session state

Known limits (acceptable for a small internal team):

- **Disk-read = tokens.** Anyone who can read the container's filesystem can read
  every stored user token. Mitigate by keeping the container single-purpose and the
  volume private (host-provided volumes are encrypted at rest anyway).
- **No individual revocation.** Tokens expire (default 30 days); rotating
  `PROCORE_MCP_TOKEN_SECRET` invalidates all of them immediately.
- Pending sign-in state lives in memory — fine for one instance; move it to Redis if
  you ever run more than one.

Upgrade path when/if the team grows beyond ~dozens of trusted users:

1. Replace the four functions in `src/auth/user-token-store.ts` with a DynamoDB or
   S3 backend using KMS encryption-at-rest (callers never change).
2. Optionally move the pending-auth/grant maps behind Redis.
3. Consider shortening `PROCORE_MCP_ACCESS_TOKEN_TTL`.

Until then, the current design is the right amount of security: real isolation
between users, no plaintext secrets in Git or client configs, and no infrastructure
you have to babysit.
