# xinas_node_build

Node 20 toolchain (NodeSource) + the xiNAS-MCP TypeScript build
(`npm ci` + `npm run build` → `dist/`). Extracted from `xinas_mcp`
(S8 T1, ADR-0010) so the build artifacts are provisioned independently
of the legacy MCP daemon. Consumers: `xinas_api`, `xinas_agent`, and
the `xinas_mcp` shim.

| Variable | Default | Purpose |
|---|---|---|
| `xinas_node_build_repo_path` | `/opt/xiNAS/xiNAS-MCP` | Repo build directory |

Run BEFORE `xinas_nfs_helper`, `xinas_api`, `xinas_agent`, `xinas_mcp`.

## Restarting the dist/ consumers

The build **notifies handlers that restart `xinas-api` and `xinas-agent`**
(in that order — the agent `Requires=` the api). Node reads its JS once at
process start, so rewriting `dist/` alone leaves both daemons executing the
previous build; nothing else restarts them for a change confined to
`xiNAS-MCP/src`, because the `xinas_api` / `xinas_agent` handlers fire only
on *their own* unit/config changes.

Consequences worth knowing:

- `npm run build` is unconditionally `changed`, so **every** run of this
  role restarts both services — including a converged `site.yml` re-run.
  That is intentional: after a rebuild the running processes are stale
  relative to `dist/` by definition.
- A host with neither unit installed (first install, or a
  `--tags xinas_node_build` run where the control path was never deployed)
  skips the restart rather than failing — `xinas_api` / `xinas_agent` start
  the services themselves against the freshly built `dist/`.
- Therefore `Requires-Rebuild: xinas_node_build` is **sufficient** for a
  TypeScript-only change; it no longer has to be paired with `xinas_api` /
  `xinas_agent` to take effect. See `docs/Installer/update-spec.md`
  §*Rebuilding dist/ restarts its consumers*.
