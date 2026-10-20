---
paths:
  - "xiNAS-MCP/**"
  - "docs/control-path/**"
---

# Control path rules

- A commit that changes `xiNAS-MCP/src/**` must carry
  `Requires-Rebuild: xinas_node_build`; `dist/` is untracked and the
  daemons read their JS once at start.
- `docs/control-path/api-v1.yaml` is CI-gated (Spectral, `oasdiff`):
  additive changes only unless an ADR approves a breaking one.
- ADRs under `docs/control-path/adr/` supersede slice specs where they
  conflict. Check ADR-0002 (agent privilege), ADR-0003 (state store),
  ADR-0004 (task engine), ADR-0010 (clients) before adding a route,
  tool, collector or mutation.
- Every MCP `mode=apply` needs a human confirmation after
  `mcp.allow_apply` (S15); scope agent tokens with `"surface": "mcp"`.
- Run the TypeScript suite on Node 20, and `npm run build` before
  `npm run test:e2e`.
