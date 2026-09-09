/**
 * `health.context` (S19 spec §6, ADR-0018 §2): the validated run context an
 * agentic health check starts from.
 *
 * Everything here is derived from the KV store, the heartbeat tracker's
 * last snapshot, the api's cached last probe and the static catalog — it
 * MUST NOT call the agent (§6.1): the context answers when the agent is
 * down and says so in `collectors.heartbeat`. Nothing in it is a
 * permission the model can enlarge: `permitted` restates what the catalog
 * rank, the client type and `mcp.allow_apply` already enforce (ARCH-03).
 *
 * `declared_absent` is proven, never inferred from an empty answer (AC-04,
 * PROMPT-02): a component is absent only when the inventory says so.
 */

import type { OpenedStateStore, RevisionedValue } from '../../state/index.js';
import type { Role } from '../config.js';
import type { Warning } from '../envelope.js';
import type { HeartbeatTracker } from '../heartbeat.js';
import { CATALOG, type MinRole, ROLE_RANK, mcpVisible } from '../mcp/catalog.js';
import { SERVER_INFO } from '../mcp/discover.js';
import { sectionsWithoutChecker } from './baseline.js';
import type { HealthPromptContext } from './prompt-context.js';
import type { RunEntry } from './run-ledger.js';

export type ProbeRunPermission = 'denied' | 'confirmable' | 'allowed';

export interface Permitted {
  deterministic: string[];
  baseline: boolean;
  probe_run: ProbeRunPermission;
  apply: false;
}

/** Catalog rank of a role; roles outside the MCP rank table rank below viewer. */
export function rankOf(role: string): number {
  return ROLE_RANK[role as MinRole] ?? -1;
}

/**
 * §6.2 `permitted`: `deep` (the S7 active-probe profile, G-04) and
 * `health.probe.run` need the operator rank AND, over MCP, `mcp.allow_apply`;
 * over MCP a probe is additionally confirmable (S15), on REST it is allowed
 * outright. `apply` is always false: remediation is a separate workflow
 * (SAFE-03). `baseline` says whether the S19c adapter is installed.
 */
export function permittedFor(
  role: Role,
  clientType: 'rest' | 'mcp',
  allowApply: boolean,
  baselineInstalled = false,
): Permitted {
  const operator = rankOf(role) >= ROLE_RANK.operator;
  const applyClass = clientType === 'rest' || allowApply;
  let probe_run: ProbeRunPermission = 'denied';
  if (operator) {
    if (clientType === 'rest') probe_run = 'allowed';
    else if (allowApply) probe_run = 'confirmable';
  }
  return {
    deterministic: operator && applyClass ? ['quick', 'standard', 'deep'] : ['quick', 'standard'],
    baseline: baselineInstalled,
    probe_run,
    apply: false,
  };
}

export interface DeclaredAbsentInput {
  /** Desired Share rows. */
  shares: number;
  /** `status.load_state` of the observed `nfs-server.service` row; null = not observed. */
  nfsUnitLoadState: string | null;
  /** Observed XiraidArray rows. */
  arrays: number;
  /** The agent's collector map from the last probe or heartbeat; null = unknown. */
  collectors: Record<string, string> | null;
}

/** §6.2: absent only when the inventory proves it; otherwise unknown, so not listed. */
export function declaredAbsent(input: DeclaredAbsentInput): string[] {
  const out: string[] = [];
  if (input.shares === 0 && input.nfsUnitLoadState === 'not-found') out.push('nfs');
  if (input.arrays === 0 && input.collectors?.XiraidArray === 'running') out.push('raid');
  return out;
}

export function runUnknownWarning(runId: string): Warning {
  return {
    code: 'RUN_UNKNOWN',
    message:
      'run_id is not known to this api process (expired, started by another principal, or the api restarted); this result is not recorded in a run ledger',
    details: { run_id: runId },
  };
}

interface KvValue {
  kind?: unknown;
  id?: unknown;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

interface KindRow {
  kind: string;
  id: string;
  row: RevisionedValue<KvValue>;
}

const OBSERVED_PREFIX = '/xinas/v1/observed/';
const DESIRED_PREFIX = '/xinas/v1/desired/';

function rowsUnder(state: OpenedStateStore, prefix: string): KindRow[] {
  const out: KindRow[] = [];
  for (const row of state.kv.list<KvValue>({ prefix })) {
    const rest = row.key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) continue;
    out.push({ kind: rest.slice(0, slash), id: rest.slice(slash + 1), row });
  }
  return out.sort((a, b) =>
    a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind),
  );
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function observedAt(row: RevisionedValue<KvValue>): string {
  return str(row.value.status?.observed_at) ?? new Date(row.modified_at).toISOString();
}

/** Longest mountpoint that contains `path` (equal, or a parent directory). */
function filesystemFor(
  path: string,
  filesystems: Array<{ id: string; mountpoint: string | null }>,
): string | null {
  let best: { id: string; length: number } | null = null;
  for (const fs of filesystems) {
    const mp = fs.mountpoint;
    if (mp === null || mp.length === 0) continue;
    const dir = mp.endsWith('/') ? mp : `${mp}/`;
    if (path === mp || path.startsWith(dir)) {
      if (best === null || mp.length > best.length) best = { id: fs.id, length: mp.length };
    }
  }
  return best?.id ?? null;
}

export interface HealthContextDeps {
  state: OpenedStateStore;
  tracker?: HeartbeatTracker;
  healthPrompt: HealthPromptContext;
  controllerId: string;
  allowApply: boolean;
  identity: { principal: string; role: Role; client_type: 'rest' | 'mcp' };
  run: RunEntry;
  targets: string[];
  hostname: string;
}

/** The §6.2 body. Pure over its inputs; the route mints the run and owns the warnings. */
export function buildHealthContext(deps: HealthContextDeps): Record<string, unknown> {
  const { healthPrompt, run } = deps;
  const observed = rowsUnder(deps.state, OBSERVED_PREFIX);
  const desired = rowsUnder(deps.state, DESIRED_PREFIX);
  const ofKind = (rows: KindRow[], kind: string) => rows.filter((r) => r.kind === kind);

  const arrayRows = ofKind(observed, 'XiraidArray');
  const arrays = arrayRows.map(({ id, row }) => ({
    id,
    state: str(row.value.status?.state),
    revision: row.revision,
    observed_at: observedAt(row),
    member_disk_ids: Array.isArray(row.value.spec?.member_disk_ids)
      ? (row.value.spec.member_disk_ids as unknown[]).filter(
          (d): d is string => typeof d === 'string',
        )
      : [],
  }));
  const volumePathOf = new Map<string, string>();
  for (const { id, row } of arrayRows) {
    const vp = str(row.value.status?.volume_path);
    if (vp !== null) volumePathOf.set(vp, id);
  }
  const filesystems = ofKind(observed, 'Filesystem').map(({ id, row }) => {
    const backing = str(row.value.status?.backing_device);
    return {
      id,
      array_id: backing === null ? null : (volumePathOf.get(backing) ?? null),
      mountpoint: str(row.value.status?.mountpoint),
      mounted: bool(row.value.status?.mounted),
      revision: row.revision,
      observed_at: observedAt(row),
    };
  });
  const shareRows = ofKind(desired, 'Share');
  const shares = shareRows.map(({ id, row }) => {
    const path = str(row.value.spec?.path);
    return { id, path, filesystem_id: path === null ? null : filesystemFor(path, filesystems) };
  });
  const interfaces = ofKind(observed, 'NetworkInterface').map(({ id, row }) => ({
    id,
    operstate: str(row.value.status?.operstate),
    mtu: num(row.value.status?.mtu),
    revision: row.revision,
    observed_at: observedAt(row),
  }));

  const heartbeat = deps.tracker?.currentState() ?? 'offline';
  const lastProbe = healthPrompt.lastProbe;
  // A stale collector map from before the agent went away proves nothing.
  const collectors =
    heartbeat === 'offline'
      ? null
      : (lastProbe?.collectors ?? deps.tracker?.currentSnapshot().collectors ?? null);
  const nfsUnit = observed.find((r) => r.kind === 'SystemdUnit' && r.id === 'nfs-server.service');
  const declared_absent = declaredAbsent({
    shares: shareRows.length,
    nfsUnitLoadState: nfsUnit === undefined ? null : str(nfsUnit.row.value.status?.load_state),
    arrays: arrayRows.length,
    collectors,
  });

  const freshness: Record<
    string,
    { rows: number; newest_observed_at: string; oldest_observed_at: string }
  > = {};
  for (const { kind, row } of observed) {
    const at = observedAt(row);
    const f = freshness[kind];
    if (f === undefined) {
      freshness[kind] = { rows: 1, newest_observed_at: at, oldest_observed_at: at };
    } else {
      f.rows += 1;
      if (Date.parse(at) > Date.parse(f.newest_observed_at)) f.newest_observed_at = at;
      if (Date.parse(at) < Date.parse(f.oldest_observed_at)) f.oldest_observed_at = at;
    }
  }

  const inventory = observed.find((r) => r.kind === 'inventory' && r.id === 'snapshot');
  const callerRank = rankOf(deps.identity.role);
  const tools = CATALOG.filter(
    (e) => mcpVisible(e) && callerRank >= (ROLE_RANK[e.min_role] ?? Number.POSITIVE_INFINITY),
  ).map((e) => ({
    name: e.name,
    min_role: e.min_role,
    ...(e.escalation !== undefined
      ? {
          escalation: {
            arg: e.escalation.arg,
            value: e.escalation.value,
            min_role: e.escalation.min_role,
            requires_mcp_apply: e.escalation.requires_mcp_apply,
          },
        }
      : {}),
  }));

  const resolved: Array<{ id: string; kind: string; source: 'observed' | 'desired' }> = [];
  const unknown: string[] = [];
  for (const target of deps.targets) {
    const o = observed.find((r) => r.id === target);
    const d = o === undefined ? desired.find((r) => r.id === target) : undefined;
    if (o !== undefined) resolved.push({ id: target, kind: o.kind, source: 'observed' });
    else if (d !== undefined) resolved.push({ id: target, kind: d.kind, source: 'desired' });
    else unknown.push(target);
  }

  const { run_ttl_seconds: _ttl, ...limits } = run.limits;
  return {
    run: {
      run_id: run.run_id,
      issued_at: new Date(run.issued_at).toISOString(),
      expires_at: new Date(run.expires_at).toISOString(),
      principal: run.principal,
      role: run.role,
      versions: run.versions,
      limits,
      permitted: permittedFor(
        deps.identity.role,
        deps.identity.client_type,
        deps.allowApply,
        CATALOG.some((e) => e.name === 'health.baseline'),
      ),
    },
    node: {
      hostname: deps.hostname,
      controller_id: deps.controllerId,
      xinas_version: SERVER_INFO.version,
      kernel: inventory === undefined ? null : str(inventory.row.value.status?.os_kernel),
      // No collector observes the xiRAID version yet (spec §6.2 deviation).
      xiraid_version: null,
    },
    topology: { arrays, filesystems, shares, interfaces, declared_absent },
    collectors: { heartbeat, last_probe: lastProbe },
    freshness,
    // S19c §8.5: once a baseline call has asked the engine which sections it
    // checks, the gap is computed from that list; before, from the static copy.
    baselines: {
      dir: healthPrompt.profiles.dir,
      dir_present: healthPrompt.profiles.dir_present,
      sections_source: healthPrompt.engineSections === null ? 'static' : 'engine',
      engine_version: healthPrompt.engineSections?.version ?? null,
      profiles: healthPrompt.profiles.profiles.map((p) => ({
        ...p,
        sections_without_checker: sectionsWithoutChecker(p, healthPrompt.engineSections),
      })),
    },
    catalog: { version: healthPrompt.versions.catalog, tool: 'health.catalog' },
    tools,
    targets: { resolved, unknown },
  };
}
