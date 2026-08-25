# Working on the Procore MCP server

- Use Node.js 20 or newer and install with `npm ci`.
- Run `npm run build`, `npm run validate`, and `npm test` before handing off changes. `npm run build` validates the committed generated catalog and compiles TypeScript.
- `specs/combined_OAS.json` is optional and gitignored. Only maintainers with a fresh Procore OAS should run `npm run build:from-oas`; review generated `data/` changes before committing them.
- Keep `.env`, OAuth client secrets, token files, and secret-bearing client configuration out of Git. Repository-scoped Codex configuration must not contain credentials. Use Procore sandbox credentials for development when possible.
- `procore_api_call` can change external Procore data. Treat mutating calls as external writes, explain the intended effect, and get confirmation before approving them. Prefer read-only discovery and verification calls first.
- Do not use `sudo npm run auth`. Run OAuth as the normal user so token files keep the expected owner and permissions.
- Preserve the upstream author's MIT license and copyright notice in `LICENSE` when modifying or redistributing the fork.
