# Private hosted Procore MCP with OpenAI Secure MCP Tunnel

## Purpose

This document describes a practical way to give employees access to Procore data
from ChatGPT without installing an MCP server on each employee's computer and
without placing the MCP endpoint directly on the public internet.

This is a target architecture and rollout plan. The repository is not ready to
deploy this way unchanged. The security work and proof tests listed below should
be completed first.

## Recommendation

Start with a private, read-only deployment for ChatGPT Business:

1. Host one copy of the Procore MCP on Render or Railway.
2. Do not assign the MCP service a public domain.
3. Run OpenAI's `tunnel-client` beside it or as a second private worker.
4. Associate the tunnel with the company's ChatGPT workspace.
5. Have each employee sign in to Procore as themselves.
6. Admit only users who belong to an approved Procore company.
7. Replace the generic API tool with a short list of approved read tools before
   the employee pilot.

Render is the first choice for an initial deployment because its private service,
background worker, and managed Postgres model maps cleanly to this design.
Railway is a close second and may feel simpler if its project canvas and deployment
workflow are more comfortable. Fly.io can do the job, but it exposes more
infrastructure details and is harder to recommend when one person will operate the
service.

Do not enable Procore writes in the first release.

## What Secure MCP Tunnel changes

A normal remote MCP deployment works like this:

```text
ChatGPT -> public HTTPS /mcp -> hosted MCP -> Procore
```

The public address is not supposed to grant access by itself. OAuth protects it.
Even so, a public endpoint gets scanned, probed, and deliberately attacked like any
other internet service.

Secure MCP Tunnel reverses the connection:

```text
ChatGPT workspace
       |
OpenAI-hosted tunnel endpoint
       |
outbound HTTPS connection
       |
tunnel-client on the hosting platform
       |
private MCP service
       |
Procore API
```

The hosted `tunnel-client` makes an outbound HTTPS connection to OpenAI, polls for
MCP work, sends each request to the private MCP, and returns the result through the
same connection. The private MCP does not need an inbound public port. OpenAI's
[Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
documents the outbound-only connection, workspace association, and support for
private HTTP or stdio MCP servers.

The tunnel does not eliminate hosting. Something still needs to run continuously,
store Procore credentials safely, refresh them, and make requests to Procore. The
tunnel removes the public MCP ingress path.

## What employees need to install

Nothing should be installed on employee machines for the ChatGPT workflow.

An administrator creates the ChatGPT app or plugin connection, selects the tunnel,
checks the discovered tools, and makes it available under the company's workspace
policy. Employees then link their Procore identity when prompted.

OpenAI documents public HTTPS and Secure MCP Tunnel as the two connection choices
in the [ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
Developer mode and tunnel permissions are separate. A tunnel must be associated
with the intended ChatGPT workspace and the operator needs the relevant Platform
tunnel permissions.

The presence of tunnel settings in the OpenAI Platform account is a good sign, but
it is not the final availability test. Before building around the feature, prove
that:

1. A tunnel can be created in the correct OpenAI Platform organization.
2. The ChatGPT Business workspace can be associated with that tunnel.
3. The tunnel appears as a connection choice in the ChatGPT app builder.
4. A test MCP tool can be listed and called from a workspace chat.

If any of these steps are unavailable, ask OpenAI support whether the Platform
organization and ChatGPT Business workspace need to be linked.

## The unresolved Procore OAuth callback

This is the most important proof test.

The tunnel documentation clearly covers MCP JSON-RPC requests and responses. The
current server also acts as an OAuth broker. During login, Procore sends the user's
browser to this callback:

```text
https://<our-host>/oauth/callback
```

That browser redirect originates from Procore, not from an MCP tool call. The
official tunnel documentation does not clearly state that an arbitrary third-party
OAuth provider can reach private callback routes through the tunnel.

Do not assume the current hosted OAuth flow works unchanged behind Secure MCP
Tunnel. Run a sandbox proof first.

There are two possible outcomes:

### Outcome A: the tunnel supports the complete linked-account flow

If the OpenAI tunnel endpoint can carry the required authorization metadata and
callback flow, the whole MCP may remain private. Document the exact callback URI
shown by ChatGPT and register it in the Procore Developer Portal.

### Outcome B: Procore still requires a public callback owned by us

Keep the MCP private and deploy a very small public OAuth service with only these
routes:

```text
GET  /.well-known/oauth-authorization-server
GET  /oauth/authorize
GET  /oauth/callback
POST /oauth/token
GET  /healthz
```

The public service would handle browser redirects and store the resulting Procore
tokens in the same encrypted database used by the private MCP. It would not expose
`/mcp` or any Procore tools. Put rate limits and managed HTTPS in front of it.

This is still a meaningful security improvement. A public OAuth edge has a small,
well-defined job. The service capable of querying Procore remains unreachable from
the internet.

## Authentication layers

There are three identities in this system. Keeping them separate makes the design
easier to reason about.

| Identity | Proves | Stored where |
| --- | --- | --- |
| OpenAI tunnel identity | This tunnel client belongs to the approved Platform organization and workspace | Hosting secret manager |
| MCP user identity | This ChatGPT connection belongs to an admitted employee | MCP authorization data |
| Procore identity | Which Procore user and permissions apply to an API request | Encrypted token store |

The tunnel authenticates the connection to OpenAI. It does not replace Procore
OAuth or decide what an employee may read from Procore.

The MCP must continue to verify an access token for every request. Current OpenAI
guidance also requires the OAuth `resource` value to travel through authorization
and token exchange so the resulting token is usable only for the intended MCP.
See [OpenAI's MCP authentication guide](https://developers.openai.com/plugins/build/auth).

## Employee and company admission

Successfully logging in to Procore is not enough. The server should check who
logged in before issuing an MCP token.

After exchanging the Procore authorization code:

1. Call Procore's current-user endpoint with the new token.
2. Record the stable Procore user ID. Do not create a new random identity for every
   login as the current implementation does.
3. Confirm the user belongs to a company ID listed in
   `PROCORE_ALLOWED_COMPANY_IDS`.
4. Optionally require an approved email domain as a second check.
5. Reject the login and delete the new Procore tokens if admission fails.

Every Procore request should also reject a company ID outside the allowlist before
it reaches the Procore API. Procore's own permissions remain the final data-access
check, but the MCP should enforce the company boundary too.

## Token storage

The current hosted implementation writes plaintext Procore access and refresh
tokens to per-user files. File permissions help against accidental access on the
same machine, but anyone who reads the volume can read every token.

The production target should use managed Postgres and encrypt each token payload
before writing it:

```text
Procore token
    -> encrypt with a per-record data key
    -> store ciphertext in Postgres
    -> protect or wrap the data key with a managed encryption key
```

Use the hosting platform's secret manager for:

- `PROCORE_CLIENT_SECRET`
- `PROCORE_MCP_TOKEN_SECRET`
- the OpenAI tunnel runtime API key
- the database connection string
- the token-encryption key or key-management credentials

Do not print these values. Do not log request authorization headers, Procore OAuth
codes, access tokens, refresh tokens, database rows, or full token-exchange error
bodies.

Required lifecycle features:

- A stable user-to-token mapping.
- Individual disconnect and revocation.
- Refresh-token rotation stored atomically.
- A short MCP access-token lifetime, initially one to eight hours.
- Deletion of Procore credentials when a user is removed.
- Rotation procedures for the Procore client secret, MCP signing secret, database
  credentials, encryption keys, and tunnel key.

Encryption limits the damage from a stolen database or backup. It does not protect
tokens from a fully compromised running application, because the application must
decrypt a token to use it.

## Tool policy for the first release

Do not give employees the current generic `procore_api_call` tool in production.
It accepts arbitrary Procore paths and makes the entire reachable Procore API
available through one tool.

Create a separate employee tool mode containing a small list of explicit GET tools.
A reasonable pilot might include:

- Find projects the user can access.
- Get project details.
- Search and read RFIs.
- Search and read submittals.
- Search and read specifications or drawings.
- Read schedule milestones.
- Read approved project-status inputs.

Each tool should validate company and project IDs, cap pagination, limit response
size, and return only fields needed for the employee use case. Add tools when real
usage shows they are needed.

Keep `PROCORE_READ_ONLY=true`. Tool descriptions and MCP annotations help the model,
but the server-side HTTP-method check remains the real control.

## Hosting choices

### Render: recommended starting point

Suggested layout:

```text
Render private service: Procore MCP over internal HTTP
Render background worker: OpenAI tunnel-client
Render Postgres: encrypted tokens, user records, grants, and revocation state
Optional Render web service: OAuth callback only, if the sandbox proof requires it
```

Render private services do not receive a public URL. Background workers run
continuously and can make outbound requests. Services in the same region can use
Render's private network. See Render's documentation for
[private services](https://render.com/docs/private-services),
[background workers and service types](https://render.com/docs/service-types), and
[private networking](https://render.com/docs/private-network).

Use managed Postgres instead of a filesystem disk once encrypted database token
storage exists. A disk is acceptable for an isolated sandbox proof, but it preserves
the current plaintext-token risk and prevents easy horizontal scaling.

### Railway: close alternative

Suggested layout:

```text
Railway service without a public domain: Procore MCP
Railway service: OpenAI tunnel-client
Railway Postgres: encrypted tokens and authorization state
Optional public Railway service: OAuth callback only
```

Railway services in one project communicate through internal DNS over its private
network. Public domains are opt-in, so the MCP service should not receive one. See
Railway's documentation for
[private networking](https://docs.railway.com/networking/private-networking) and
[domain configuration](https://docs.railway.com/networking/domains/working-with-domains).

Railway is a good choice if getting a few related services running quickly matters
more than having explicit service types for private APIs and workers.

### Fly.io: capable but more operational work

Fly Machines, private networking, process groups, secrets, and volumes can support
this architecture. The tradeoff is that more of the network and machine lifecycle
configuration becomes our responsibility. Fly is reasonable if there is already
Fly experience on the team. Otherwise, Render or Railway is the safer first choice
for a one-person operation.

## Service topology for the first proof

Do not begin with the final multi-service production layout. Prove the risky parts
in this order:

### Proof 1: tunnel reachability

Run a harmless MCP server with one tool returning a static string. Connect it
through Secure MCP Tunnel and call it from ChatGPT Business.

Success means the tunnel is visible to the workspace and tool traffic works.

### Proof 2: private hosted MCP

Deploy the real MCP privately with sandbox Procore credentials and keep read-only
mode on. Run `tunnel-client` on the same platform and verify tool discovery and a
local catalog-only tool.

Success means the hosting provider can keep both processes alive and the tunnel can
reach the private service.

### Proof 3: Procore linked-account flow

Complete Procore OAuth from ChatGPT through the tunnel and call Procore's current-user
endpoint.

Success means the complete OAuth callback path works and the response names the
employee who signed in. If it fails because Procore cannot reach the callback,
implement the small public OAuth service described earlier.

### Proof 4: employee admission and isolation

Use two sandbox users. Verify that:

- Each user receives only their own Procore permissions.
- One user's defaults and refreshed tokens never affect the other.
- An account outside the approved company is rejected.
- Disconnecting one user invalidates that user without affecting the other.

Only after these proofs should production Procore credentials be introduced.

## Production minimums

Before the employee pilot:

- Keep the MCP private through Secure MCP Tunnel.
- Keep Procore reads only.
- Enforce an approved Procore company allowlist.
- Use stable Procore user IDs.
- Store encrypted tokens in managed Postgres.
- Implement individual disconnect and revocation.
- Implement current MCP `resource` and client-identification requirements.
- Replace the generic API tool with approved read tools.
- Add per-user request limits and OAuth rate limits.
- Cap response sizes and pagination.
- Add structured audit logs without sensitive values.
- Alert on repeated login failures, admission failures, and unusual request volume.
- Document secret rotation and incident response.
- Confirm backups contain ciphertext rather than plaintext token files.

## Incident response in plain language

If an employee's MCP token is exposed, revoke that user's MCP session and Procore
tokens.

If the token database is exposed, rotate the token-encryption key as appropriate,
revoke all stored Procore tokens, and require users to reconnect.

If `PROCORE_MCP_TOKEN_SECRET` is exposed, rotate it immediately. This invalidates all
MCP access tokens.

If the Procore client secret is exposed, rotate it in Procore and update the hosting
secret manager.

If the tunnel runtime key is exposed, revoke it in OpenAI Platform settings and
issue a new one. Review tunnel and app invocation logs for unexpected activity.

## Scope decisions

The first release is:

- ChatGPT Business only.
- Internal employees only.
- One approved Procore company.
- Read-only.
- A short list of explicit tools.
- A small pilot before workspace-wide release.

The first release is not:

- A public MCP service for arbitrary clients.
- A general proxy for the complete Procore API.
- A write-capable Procore agent.
- A highly available multi-region system.
- A replacement for Procore's permission system or audit history.

Support for Claude or other MCP clients should be evaluated later. Secure MCP Tunnel
solves the OpenAI connection path; it does not create a universal private endpoint
for every MCP client.

## Next actions

1. Create a throwaway OpenAI tunnel and verify it appears in the ChatGPT Business
   app builder.
2. Run the static-tool tunnel proof.
3. Choose Render unless Railway has a clear operational advantage for the team.
4. Test the Procore sandbox OAuth flow through the tunnel.
5. Decide whether a public OAuth callback service is required.
6. Implement the production minimums before deploying production credentials.
7. Pilot with three to five employees and review actual usage before expanding the
   tool list.

