/**
 * The declarative client catalog (S8 T2, ADR-0010 §catalog).
 *
 * ONE table drives three consumers:
 *  - the MCP tools/list + call dispatcher (REST-shaped tool names);
 *  - xinasctl's generated command tree;
 *  - the REST rbacMiddleware (min_role per route — review P0).
 *
 * Entries marked `degraded` are present in the tree but their backing
 * route still returns a warning-stub envelope; the warning passes
 * through to the client verbatim (coverage honesty, review P1).
 * Entries with `binary: true` stream non-JSON bodies — generated for
 * the CLI but EXCLUDED from MCP tools/list.
 *
 * Paths are RELATIVE to the /api/v1 router ('{x}' segments are path
 * parameters). T5 (read-route promotion) appends its entries when the
 * routes land — the catalog only ever lists mounted routes.
 */

export type Mutability = 'read' | 'plan_apply' | 'direct';
export type MinRole = 'viewer' | 'operator' | 'admin';

export interface CatalogEntry {
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  input_schema: Record<string, unknown>;
  mutability: Mutability;
  /** Explicit per entry — never inferred from request bodies (review P1). */
  requires_mcp_apply: boolean;
  min_role: MinRole;
  status: 'live' | 'degraded';
  /** Streams a non-JSON body: CLI-only, excluded from MCP tools. */
  binary?: boolean;
}

const NO_INPUT: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const idInput = (name: string, description: string): Record<string, unknown> => ({
  type: 'object',
  properties: { [name]: { type: 'string', description } },
  required: [name],
  additionalProperties: false,
});

/** The generic plan/apply mutation body (api-v1 plan/apply contract). */
const MUTATE_PROPS: Record<string, unknown> = {
  mode: {
    type: 'string',
    enum: ['plan', 'apply'],
    description: 'plan computes a diff; apply executes a previously returned plan_id',
  },
  spec: {
    type: 'object',
    description: 'operation spec (see api-v1.yaml for the per-resource schema)',
  },
  plan_id: { type: 'string', description: 'required for mode=apply' },
  idempotency_key: { type: 'string' },
  dangerous: { type: 'boolean', description: 'required true for destructive operations' },
};

const mutateInput = (withId?: string): Record<string, unknown> => ({
  type: 'object',
  properties: {
    ...(withId !== undefined ? { [withId]: { type: 'string' } } : {}),
    ...MUTATE_PROPS,
  },
  required: [...(withId !== undefined ? [withId] : []), 'mode'],
  additionalProperties: true,
});

const read = (
  name: string,
  method: 'GET',
  path: string,
  description: string,
  over: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  name,
  description,
  method,
  path,
  input_schema: path.includes('{') ? idInput(paramOf(path), 'resource id') : NO_INPUT,
  mutability: 'read',
  requires_mcp_apply: false,
  min_role: 'viewer',
  status: 'live',
  ...over,
});

const planApply = (
  name: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  description: string,
  minRole: MinRole,
  over: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  name,
  description,
  method,
  path,
  input_schema: mutateInput(path.includes('{') ? paramOf(path) : undefined),
  mutability: 'plan_apply',
  requires_mcp_apply: true,
  min_role: minRole,
  status: 'live',
  ...over,
});

function paramOf(path: string): string {
  const m = /\{([^}]+)\}/.exec(path);
  return m?.[1] ?? 'id';
}

export const CATALOG: CatalogEntry[] = [
  // ── arrays (xiRAID) — RAID mutation is admin (legacy matrix) ──
  read('arrays.list', 'GET', '/arrays', 'List xiRAID arrays (observed state).'),
  read('arrays.get', 'GET', '/arrays/{id}', 'Get one xiRAID array.'),
  planApply('arrays.create', 'POST', '/arrays', 'Create a xiRAID array (plan/apply).', 'admin'),
  planApply(
    'arrays.import',
    'POST',
    '/arrays',
    'Import an existing xiRAID array (plan/apply; spec.import).',
    'admin',
  ),
  planApply(
    'arrays.modify',
    'PATCH',
    '/arrays/{id}',
    'Modify a xiRAID array (plan/apply).',
    'admin',
  ),
  planApply(
    'arrays.delete',
    'DELETE',
    '/arrays/{id}',
    'Delete a xiRAID array (plan/apply; dangerous).',
    'admin',
  ),

  // ── disks ──
  read('disks.list', 'GET', '/disks', 'List disks (observed state incl. health where reported).'),
  read(
    'disks.get',
    'GET',
    '/disks/{id}',
    'Get one disk (status.health covers the legacy SMART read where the probe reports it).',
  ),

  // ── filesystems ──
  read('filesystems.list', 'GET', '/filesystems', 'List managed filesystems.'),
  read('filesystems.get', 'GET', '/filesystems/{id}', 'Get one managed filesystem.'),
  planApply(
    'filesystems.create',
    'POST',
    '/filesystems',
    'Create an XFS filesystem (plan/apply).',
    'admin',
  ),
  planApply(
    'filesystems.update',
    'PATCH',
    '/filesystems/{id}',
    'Mount/unmount/grow/quota (one intent per call; plan/apply).',
    'admin',
  ),
  planApply(
    'filesystems.delete',
    'DELETE',
    '/filesystems/{id}',
    'Unmanage a filesystem (plan/apply; dangerous).',
    'admin',
  ),

  // ── shares (NFS) — share operations are operator (legacy matrix) ──
  read('shares.list', 'GET', '/shares', 'List NFS shares (desired + observed exports).'),
  read('shares.get', 'GET', '/shares/{id}', 'Get one NFS share.'),
  read('nfs_sessions.list', 'GET', '/shares/{id}/sessions', 'Active NFS sessions for a share.'),
  planApply('shares.create', 'POST', '/shares', 'Create an NFS share (plan/apply).', 'operator'),
  planApply(
    'shares.update',
    'PATCH',
    '/shares/{id}',
    'Update an NFS share (plan/apply).',
    'operator',
  ),
  planApply(
    'shares.delete',
    'DELETE',
    '/shares/{id}',
    'Delete an NFS share (plan/apply; dangerous).',
    'operator',
  ),
  read('export_groups.list', 'GET', '/export-groups', 'List export groups.'),
  read('service_ips.list', 'GET', '/service-ips', 'List service IPs.'),

  // ── NFS profile / idmap ──
  read('nfs_profiles.list', 'GET', '/nfs-profiles', 'List NFS server profiles.'),
  read('nfs_profiles.get', 'GET', '/nfs-profiles/{id}', 'Get an NFS server profile.'),
  planApply(
    'nfs_profiles.update',
    'PATCH',
    '/nfs-profiles/{id}',
    'Update the NFS server profile (plan/apply).',
    'admin',
  ),
  read('nfs_idmap.get', 'GET', '/nfs-idmap', 'Get the NFSv4 idmap configuration.'),
  planApply(
    'nfs_idmap.set',
    'PATCH',
    '/nfs-idmap',
    'Set the NFSv4 idmap domain (plan/apply).',
    'operator',
  ),

  // ── network ──
  read('network.list', 'GET', '/network', 'List network interfaces (summary).'),
  read('network.interfaces.list', 'GET', '/network/interfaces', 'List managed network interfaces.'),
  read(
    'network.interfaces.get',
    'GET',
    '/network/interfaces/{id}',
    'Get one managed network interface.',
  ),
  planApply(
    'network.interfaces.update',
    'PATCH',
    '/network/interfaces/{id}',
    'Update interface addresses/MTU/state (plan/apply).',
    'admin',
  ),
  planApply(
    'network.pool.apply',
    'POST',
    '/network/ip-pool',
    'Re-address all managed interfaces from a pool (plan/apply).',
    'admin',
  ),

  // ── health / drift ──
  {
    ...read(
      'health.check',
      'GET',
      '/health',
      'Run a health profile (quick KV-only; standard/deep add agent probes).',
    ),
    input_schema: {
      type: 'object',
      properties: {
        profile: { type: 'string', enum: ['quick', 'standard', 'deep'], default: 'quick' },
      },
      additionalProperties: false,
    },
  },
  read(
    'drift.report',
    'GET',
    '/config-history/drift',
    'Desired-vs-observed drift report (S7 engine).',
  ),

  // ── config history (live since S9, ADR-0011) ──
  read(
    'config_history.snapshots',
    'GET',
    '/config-history/snapshots',
    'List config snapshots (observed xinas_history manifests, projected).',
  ),
  read('config_history.show', 'GET', '/config-history/snapshots/{id}', 'Show one config snapshot.'),
  {
    ...read(
      'config_history.diff',
      'GET',
      '/config-history/diff',
      'Diff two snapshots (agent round-trip; degrades with EXECUTOR_UNAVAILABLE when the agent is down).',
    ),
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  planApply(
    'config_history.rollback',
    'POST',
    '/config-history/rollback',
    'Roll back to the BASELINE snapshot OR restore any restorable snapshot (file-level NFS/network config — observed recovery, re-apply to make durable). Plan/apply, destructive — dangerous:true at apply. spec = {to: "baseline" | "<snapshot-id>", reason}.',
    'admin',
  ),

  // ── tasks ──
  read('tasks.list', 'GET', '/tasks', 'List tasks.'),
  read('tasks.get', 'GET', '/tasks/{id}', 'Get one task (state, stages, error).'),
  {
    name: 'tasks.cancel',
    description:
      'Request cooperative task cancellation (S10, ADR-0012). Queued tasks cancel immediately; running tasks stop at the next stage boundary AND roll back their partial work (cancelled = nothing changed, best-effort) — a cancel after the last stage completed is ignored and the task finishes success. Allowed via MCP without allow_apply — an emergency stop cannot apply new state (ADR-0010).',
    method: 'POST',
    path: '/tasks/{id}/cancel',
    input_schema: idInput('id', 'task id'),
    mutability: 'direct',
    requires_mcp_apply: false,
    min_role: 'operator',
    status: 'live',
  },

  // ── support bundle ──
  {
    name: 'support.bundle',
    description:
      'Create a redacted support bundle (read-style diagnostic; runs as a task). Allowed via MCP without allow_apply (ADR-0010 rationale).',
    method: 'POST',
    path: '/support-bundle',
    input_schema: NO_INPUT,
    mutability: 'direct',
    requires_mcp_apply: false,
    min_role: 'operator',
    status: 'live',
  },
  read(
    'support.download',
    'GET',
    '/support-bundle/{task_id}',
    'Download a finished support bundle archive (binary; CLI only).',
    { binary: true },
  ),

  // ── system / audit ──
  read('system.get', 'GET', '/system', 'Node status (agent state, observation age).'),
  read('system.capabilities', 'GET', '/capabilities', 'API capability matrix.'),
  read('system.controllers', 'GET', '/controllers', 'List controllers.'),
  read('system.inventory', 'GET', '/inventory', 'Hardware/OS inventory.'),
  {
    ...read(
      'audit.query',
      'GET',
      '/audit',
      'Query audit records: tail filters (kind/principal/client_type/since/until/limit) or ONE exact lookup (request_id|operation_id|task_id).',
    ),
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        operation_id: { type: 'string' },
        task_id: { type: 'string' },
        kind: { type: 'string' },
        principal: { type: 'string' },
        client_type: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
      additionalProperties: false,
    },
  },

  // ── promoted legacy reads (S8 T5; ADR-0010 §read-route promotion) ──
  {
    ...read(
      'system.logs',
      'GET',
      '/system/logs',
      'Tail the systemd journal (scrubbed). Degrades with a warning when the journal group is missing.',
    ),
    input_schema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'systemd unit filter' },
        lines: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      },
      additionalProperties: false,
    },
  },
  read(
    'system.performance',
    'GET',
    '/system/performance',
    'Prometheus exporter metrics (raw text). Degrades when the exporter is unreachable.',
  ),
  read('quotas.list', 'GET', '/quotas', 'User block quotas (repquota). Degrades when unavailable.'),
  read(
    'pools.list',
    'GET',
    '/pools',
    'xiRAID spare pools (observed state; referenced_by lists arrays using each pool).',
  ),
  planApply(
    'pools.create',
    'POST',
    '/pools',
    'Create a spare pool (plan/apply; spec = {name, drives}).',
    'admin',
  ),
  planApply(
    'pools.modify',
    'PATCH',
    '/pools/{name}',
    'Modify a spare pool — ONE intent per call: add_drives | remove_drives | active (plan/apply).',
    'operator',
  ),
  planApply(
    'pools.delete',
    'DELETE',
    '/pools/{name}',
    'Delete a spare pool (plan/apply; blocked while active or referenced by an array).',
    'admin',
  ),
  read(
    'mail.recipients',
    'GET',
    '/mail/recipients',
    'xiRAID mail recipients (deprecated read-only gRPC path).',
  ),
  read(
    'mail.settings',
    'GET',
    '/mail/settings',
    'xiRAID mail settings (deprecated read-only gRPC path).',
  ),
  read(
    'auth.modes',
    'GET',
    '/auth/modes',
    'Supported NFS auth modes (deprecated read-only gRPC path).',
  ),

  // ── users / groups ──
  read('users.list', 'GET', '/users', 'List system users (NSS).'),
  read('users.get', 'GET', '/users/{uid}', 'Get one user.'),
  read('groups.list', 'GET', '/groups', 'List system groups.'),
  read('groups.get', 'GET', '/groups/{gid}', 'Get one group.'),
];

/**
 * Match a request (method + path RELATIVE to the /api/v1 router)
 * against the catalog. '{x}' segments match any single segment.
 * Returns the FIRST matching entry (same-route entries — e.g.
 * arrays.create/import — share min_role by construction).
 */
export function matchCatalog(method: string, path: string): CatalogEntry | undefined {
  const reqSegs = path.split('/').filter((s) => s.length > 0);
  return CATALOG.find((entry) => {
    if (entry.method !== method) return false;
    const segs = entry.path.split('/').filter((s) => s.length > 0);
    if (segs.length !== reqSegs.length) return false;
    return segs.every((seg, i) => seg.startsWith('{') || seg === reqSegs[i]);
  });
}

export const ROLE_RANK: Record<MinRole, number> = { viewer: 0, operator: 1, admin: 2 };
