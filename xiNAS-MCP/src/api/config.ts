import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export type Role =
  | 'viewer'
  | 'operator'
  | 'admin'
  | 'local_admin'
  // internal_agent: only the xinas-agent holds this; gates /internal/v1/observed
  // (route guard lands in a later S1 task).
  | 'internal_agent';

/**
 * S15 §3.5, §13 — which endpoint family a bearer may authenticate on.
 *
 * `any` (the default when the key is absent, and what every token minted
 * before this key existed keeps meaning) makes the token a REST credential
 * as well as an MCP one, so the MRTR confirmation gate constrains the
 * `/mcp` PATH, not the principal: the same bearer applies unconfirmed over
 * `/api/v1`. `mcp` closes that — the REST surface refuses the token.
 */
export type TokenSurface = 'mcp' | 'rest' | 'any';

export const TOKEN_SURFACES: readonly TokenSurface[] = ['mcp', 'rest', 'any'];

export interface TokenPrincipal {
  principal: string;
  role: Role;
  /**
   * The endpoint family this token may authenticate on (default `any`):
   *
   * - `mcp` — `/mcp` only. `middleware/auth.ts` refuses it on `/api/v1`
   *   with `PERMISSION_DENIED` / `details.reason: 'token_surface'`.
   * - `rest` — `/api/v1` only. `transport.ts` `resolveIdentity()` returns
   *   null, so `/mcp` answers the SAME 401 an unknown bearer gets (no
   *   oracle for which tokens exist but are scoped elsewhere).
   * - `any` — both (the default).
   *
   * Give an MCP agent's token `surface: 'mcp'`: without it the S15
   * confirmation gate can be bypassed by applying over REST with the very
   * same token (S15 §3.5).
   */
  surface?: TokenSurface;
}

export type ApproverPolicy = 'distinct_principal' | 'any_admin';

/** S15 §13 — every field optional; defaults in MCP_CONFIRMATION_DEFAULTS. */
export interface McpConfirmationConfig {
  ttl_seconds?: number;
  url_wait_seconds?: number;
  max_pending_per_principal?: number;
  max_pending_total?: number;
  create_rate_per_minute?: number;
  /** `https://host[:port][/prefix]`, or `http://` on a loopback host only. Required for URL mode. */
  approval_url_base?: string;
  approver_policy?: ApproverPolicy;
  allow_uds_approval?: boolean;
}

export interface ResolvedConfirmationConfig {
  ttl_seconds: number;
  url_wait_seconds: number;
  max_pending_per_principal: number;
  max_pending_total: number;
  create_rate_per_minute: number;
  approval_url_base: string | undefined;
  approver_policy: ApproverPolicy;
  allow_uds_approval: boolean;
}

export const MCP_CONFIRMATION_DEFAULTS: Omit<ResolvedConfirmationConfig, 'approval_url_base'> = {
  ttl_seconds: 300,
  url_wait_seconds: 25,
  max_pending_per_principal: 5,
  max_pending_total: 100,
  create_rate_per_minute: 10,
  approver_policy: 'distinct_principal',
  allow_uds_approval: false, // break-glass; spec §3.5
};

export type ListenSpec =
  | {
      kind: 'unix';
      socket: string;
      /**
       * Optional numeric gid to chown the socket file to after binding.
       * When set, server.ts runs `chown(socketPath, -1, socketGroup)`
       * so members of that group can connect (combined with the 0o660
       * mode set unconditionally). The Phase 0 Ansible role templates
       * this from the xinas-admin group's gid. When unset, the socket
       * keeps its default ownership (the process's primary group) and
       * only the api process itself can connect — safe but unusable
       * from operator tools, so production deployments MUST set this.
       */
      socketGroup?: number;
    }
  | { kind: 'tcp'; host: string; port: number };

export interface ApiConfig {
  controller_id: string;
  listen: ListenSpec;
  tokens: Record<string, TokenPrincipal>;
  state: {
    databasePath: string;
    auditJsonlPath: string;
    archiveDir?: string;
    /** HMAC key ring for MCP requestState (S15 §7.6); default beside the DB. */
    confirmationKeyPath?: string;
  };
  /**
   * Optional path to a second tokens file with stricter file permissions
   * (0640 root:xinas-api). Keeps the agent bearer out of the operator-readable
   * config.json. Entries are merged into the tokens map after config.json is
   * parsed. Key collisions between the two files are fatal at startup — rotate
   * the colliding token or remove one of the entries.
   */
  internalTokensPath?: string;
  /** When set, the api polls the agent's UDS for agent.health and tracks its state. */
  agent?: { socket: string; heartbeat_interval_ms?: number };
  /** Support-bundle directory (S7); default /var/log/xinas/bundles. */
  support_bundle_dir?: string;
  /** MCP transport (S8, ADR-0010). allow_apply default FALSE — the
   *  WS12 exit criterion is the default posture. `http` adds a
   *  dedicated TCP listener serving the same app. */
  mcp?: {
    allow_apply?: boolean;
    http?: { host: string; port: number };
    confirmation?: McpConfirmationConfig;
    /** S17 §10 — operational controls for the event journal and subscriptions. */
    subscriptions?: McpSubscriptionsConfig;
    /** S19 §12.1 — the xinas_health_check prompt, its limits and the baseline profile dir. */
    health_prompt?: McpHealthPromptConfig;
  };
  /**
   * S2.1 worker pool (s2-task-envelope-spec §5.3). `max_inflight` caps the
   * tasks concurrently in flight end-to-end (dispatch → terminal); the
   * default (4) is applied where consumed (TaskEngine), so the whole section
   * may be omitted.
   */
  tasks?: { max_inflight?: number };
  /**
   * Install-time NFS share seed (see docs/.../2026-07-03-nfs-share-seed-adoption).
   * `shares_manifest_path` points at the JSON manifest the Ansible `exports`
   * role renders (default /var/lib/xinas/seed/shares.json). Consumed once by
   * seedShares() at bootstrap; absent → the code default path is used.
   */
  seed?: { shares_manifest_path?: string };
}

const DEFAULT_PATH = '/etc/xinas-api/config.json';

/**
 * Load API config from a file (default `/etc/xinas-api/config.json`)
 * or take an inline object — the latter is for tests, where the file
 * doesn't exist and we want to inject a config directly.
 */
export function loadConfig(opts: { configPath?: string; inline?: ApiConfig } = {}): ApiConfig {
  if (opts.inline) {
    validateTasksSection(opts.inline);
    validateMcpSection(opts.inline);
    validateSubscriptionsSection(opts.inline);
    validateHealthPromptSection(opts.inline);
    validateTokensSection(opts.inline);
    return opts.inline;
  }
  const path = opts.configPath ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(
      `xinas-api config not found at ${path}; provide --config <path> or seed /etc/xinas-api/config.json`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const config = JSON.parse(raw) as ApiConfig;
  validateTasksSection(config);
  validateMcpSection(config);
  validateSubscriptionsSection(config);
  validateHealthPromptSection(config);

  if (config.internalTokensPath && existsSync(config.internalTokensPath)) {
    const internalRaw = readFileSync(config.internalTokensPath, 'utf8');
    const internal = JSON.parse(internalRaw) as Record<string, TokenPrincipal>;
    for (const [key, principal] of Object.entries(internal)) {
      if (key in config.tokens) {
        throw new Error(
          `token key collision: '${key}' appears in both ${path} and ${config.internalTokensPath}. ` +
            'Rotate the colliding token or remove one of the entries.',
        );
      }
      config.tokens[key] = principal;
    }
  }

  // Validated AFTER the internalTokensPath merge so a 'local:'-prefixed
  // principal smuggled in via the internal-tokens file is caught too.
  validateTokensSection(config);

  return config;
}

/**
 * Reject a present-but-invalid `tasks.max_inflight` at load
 * (s2-task-envelope-spec §5.3): when set it must be an integer >= 1.
 * Absent is fine — the TaskEngine applies the default (4).
 */
function validateTasksSection(config: ApiConfig): void {
  const cap = config.tasks?.max_inflight;
  if (cap === undefined) return;
  if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1) {
    throw new Error(
      `tasks.max_inflight must be an integer >= 1, got ${JSON.stringify(cap)}; ` +
        'remove the key to use the default (4)',
    );
  }
}

/**
 * F6 (S15 Task 11 fix1): the `local:` principal namespace is reserved for
 * socket-peer identities the auth middleware itself assigns (`local:uds` —
 * see middleware/auth.ts's UDS peer-trust branch); a configured bearer
 * token must never be able to impersonate one.
 */
function validateTokensSection(config: ApiConfig): void {
  for (const [key, principal] of Object.entries(config.tokens ?? {})) {
    if (principal.principal.startsWith('local:')) {
      throw new Error(
        `token '${key}': principal '${principal.principal}' is invalid — ` +
          `'local:' is reserved for socket-peer identities`,
      );
    }
    // A1 (S15 §3.5, §13): an unrecognised surface is fatal rather than
    // silently permissive — a typo like 'MCP' must never widen the token
    // back to both endpoint families.
    const surface: unknown = principal.surface;
    if (surface !== undefined && !TOKEN_SURFACES.includes(surface as TokenSurface)) {
      throw new Error(
        `token '${key}': surface ${JSON.stringify(surface)} is invalid — ` +
          `expected one of ${TOKEN_SURFACES.join(', ')} (omit the key for 'any')`,
      );
    }
    // S15 closing round C1: the mcp surface refuses internal_agent tokens
    // outright (middleware/auth.ts), so scoping one to surface: 'mcp' would
    // make it unusable on either endpoint family.
    if (principal.role === 'internal_agent' && surface === 'mcp') {
      throw new Error(
        `token '${key}': internal_agent tokens cannot be scoped to mcp — ` +
          `the MCP surface refuses that role`,
      );
    }
  }

  // S15 closing round C1: a bearer with no surface scoping is a REST
  // credential too (surface default 'any'), so with mcp.allow_apply: true
  // it can bypass the S15 confirmation gate entirely by applying over
  // /api/v1 with the same token. internal_agent tokens are exempt — that
  // role is refused on the mcp surface (middleware/auth.ts), so they can
  // never be the mcp side of the bypass this warns about.
  if (config.mcp?.allow_apply === true) {
    const unscoped = Object.entries(config.tokens ?? {})
      .filter(([, p]) => p.role !== 'internal_agent' && (p.surface ?? 'any') === 'any')
      .map(([, p]) => p.principal);
    if (unscoped.length > 0) {
      console.warn(
        `mcp.allow_apply=true with unscoped token(s) [${unscoped.join(', ')}]: ` +
          'each is a REST credential too, so the S15 confirmation gate can be bypassed ' +
          "by applying over /api/v1 with the same bearer — set surface: 'mcp' (S15 §3.5, §13)",
      );
    }
  }
}

export function confirmationKeyPathFor(config: ApiConfig): string {
  return (
    config.state.confirmationKeyPath ??
    join(dirname(config.state.databasePath), 'mcp-confirmation-keys.json')
  );
}

export function resolveConfirmationConfig(config: ApiConfig): ResolvedConfirmationConfig {
  const c = config.mcp?.confirmation ?? {};
  return {
    ttl_seconds: c.ttl_seconds ?? MCP_CONFIRMATION_DEFAULTS.ttl_seconds,
    url_wait_seconds: c.url_wait_seconds ?? MCP_CONFIRMATION_DEFAULTS.url_wait_seconds,
    max_pending_per_principal:
      c.max_pending_per_principal ?? MCP_CONFIRMATION_DEFAULTS.max_pending_per_principal,
    max_pending_total: c.max_pending_total ?? MCP_CONFIRMATION_DEFAULTS.max_pending_total,
    create_rate_per_minute:
      c.create_rate_per_minute ?? MCP_CONFIRMATION_DEFAULTS.create_rate_per_minute,
    approval_url_base: c.approval_url_base?.replace(/\/+$/, ''),
    approver_policy: c.approver_policy ?? MCP_CONFIRMATION_DEFAULTS.approver_policy,
    allow_uds_approval: c.allow_uds_approval ?? MCP_CONFIRMATION_DEFAULTS.allow_uds_approval,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function rangeCheck(name: string, value: unknown, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `mcp.confirmation.${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`,
    );
  }
}

/** S15 §13: out-of-range values fail at load, never at apply. */
function validateMcpSection(config: ApiConfig): void {
  const c = config.mcp?.confirmation;
  if (c === undefined) return;
  rangeCheck('ttl_seconds', c.ttl_seconds, 60, 900);
  rangeCheck('url_wait_seconds', c.url_wait_seconds, 1, 55);
  rangeCheck('max_pending_per_principal', c.max_pending_per_principal, 1, 50);
  rangeCheck('max_pending_total', c.max_pending_total, 1, 1000);
  rangeCheck('create_rate_per_minute', c.create_rate_per_minute, 1, 600);
  if (
    c.approver_policy !== undefined &&
    c.approver_policy !== 'distinct_principal' &&
    c.approver_policy !== 'any_admin'
  ) {
    throw new Error(`mcp.confirmation.approver_policy must be 'distinct_principal' or 'any_admin'`);
  }
  if (c.allow_uds_approval !== undefined && typeof c.allow_uds_approval !== 'boolean') {
    throw new Error('mcp.confirmation.allow_uds_approval must be a boolean');
  }
  if (c.approval_url_base !== undefined) {
    let url: URL;
    try {
      url = new URL(c.approval_url_base);
    } catch {
      throw new Error('mcp.confirmation.approval_url_base must be an absolute URL');
    }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error(
        'mcp.confirmation.approval_url_base must use https:// (http:// is accepted only on a loopback host)',
      );
    }
    if (url.search !== '' || url.hash !== '') {
      throw new Error('mcp.confirmation.approval_url_base must not carry a query or fragment');
    }
  }
  if (c.approver_policy === 'any_admin') {
    console.warn(
      'mcp.confirmation.approver_policy=any_admin: the requesting principal may approve its own destructive request',
    );
  }
  if (c.allow_uds_approval === true) {
    console.warn(
      'mcp.confirmation.allow_uds_approval=true: break-glass — anyone with root or xinas-admin on this node (an agent included) can approve MCP confirmations; every use is audited as break_glass_used',
    );
  }
}

// ── S17 §10: mcp.subscriptions ──────────────────────────────────────────

export interface CapacityThresholds {
  warning_enter: number;
  warning_clear: number;
  critical_enter: number;
  critical_clear: number;
}

/** Every field optional; defaults in SUBSCRIPTIONS_DEFAULTS. */
export interface McpSubscriptionsConfig {
  enabled?: boolean;
  retention_days?: number;
  max_rows?: number;
  cleanup_interval_s?: number;
  read_limit_default?: number;
  read_limit_max?: number;
  max_uris_per_listen?: number;
  max_listeners_per_principal?: number;
  max_listeners_per_process?: number;
  max_pending_per_stream?: number;
  keepalive_ms?: number;
  coalesce_ms?: number;
  progress?: Partial<{ bucket_pct: number; min_interval_s: number; max_silence_s: number }>;
  capacity?: Partial<CapacityThresholds> & {
    per_filesystem?: Record<string, Partial<CapacityThresholds>>;
  };
  nfs_lock_threshold?: Partial<{ enter: number; clear: number }>;
  /** A validated platform threshold; null keeps the temperature family inactive (D-10). */
  disk_temperature_c?: number | null;
}

export interface ResolvedSubscriptionsConfig {
  enabled: boolean;
  retention_days: number;
  max_rows: number;
  cleanup_interval_s: number;
  read_limit_default: number;
  read_limit_max: number;
  max_uris_per_listen: number;
  max_listeners_per_principal: number;
  max_listeners_per_process: number;
  max_pending_per_stream: number;
  keepalive_ms: number;
  coalesce_ms: number;
  progress: { bucket_pct: number; min_interval_s: number; max_silence_s: number };
  capacity: CapacityThresholds & { per_filesystem: Record<string, Partial<CapacityThresholds>> };
  nfs_lock_threshold: { enter: number; clear: number };
  disk_temperature_c: number | null;
}

export const SUBSCRIPTIONS_DEFAULTS: ResolvedSubscriptionsConfig = {
  enabled: true,
  retention_days: 7,
  max_rows: 100_000,
  cleanup_interval_s: 3600,
  read_limit_default: 100,
  read_limit_max: 500,
  max_uris_per_listen: 6,
  max_listeners_per_principal: 4,
  max_listeners_per_process: 32,
  max_pending_per_stream: 256,
  keepalive_ms: 15_000,
  coalesce_ms: 250,
  progress: { bucket_pct: 10, min_interval_s: 30, max_silence_s: 600 },
  capacity: {
    warning_enter: 80,
    warning_clear: 75,
    critical_enter: 90,
    critical_clear: 85,
    per_filesystem: {},
  },
  nfs_lock_threshold: { enter: 0, clear: 0 },
  disk_temperature_c: null,
};

export function resolveSubscriptionsConfig(config: ApiConfig): ResolvedSubscriptionsConfig {
  const c = config.mcp?.subscriptions ?? {};
  const d = SUBSCRIPTIONS_DEFAULTS;
  const { per_filesystem, ...capacityOverrides } = c.capacity ?? {};
  return {
    enabled: c.enabled ?? d.enabled,
    retention_days: c.retention_days ?? d.retention_days,
    max_rows: c.max_rows ?? d.max_rows,
    cleanup_interval_s: c.cleanup_interval_s ?? d.cleanup_interval_s,
    read_limit_default: c.read_limit_default ?? d.read_limit_default,
    read_limit_max: c.read_limit_max ?? d.read_limit_max,
    max_uris_per_listen: c.max_uris_per_listen ?? d.max_uris_per_listen,
    max_listeners_per_principal: c.max_listeners_per_principal ?? d.max_listeners_per_principal,
    max_listeners_per_process: c.max_listeners_per_process ?? d.max_listeners_per_process,
    max_pending_per_stream: c.max_pending_per_stream ?? d.max_pending_per_stream,
    keepalive_ms: c.keepalive_ms ?? d.keepalive_ms,
    coalesce_ms: c.coalesce_ms ?? d.coalesce_ms,
    progress: { ...d.progress, ...(c.progress ?? {}) },
    capacity: {
      warning_enter: capacityOverrides.warning_enter ?? d.capacity.warning_enter,
      warning_clear: capacityOverrides.warning_clear ?? d.capacity.warning_clear,
      critical_enter: capacityOverrides.critical_enter ?? d.capacity.critical_enter,
      critical_clear: capacityOverrides.critical_clear ?? d.capacity.critical_clear,
      per_filesystem: { ...(per_filesystem ?? {}) },
    },
    nfs_lock_threshold: { ...d.nfs_lock_threshold, ...(c.nfs_lock_threshold ?? {}) },
    disk_temperature_c:
      c.disk_temperature_c === undefined ? d.disk_temperature_c : c.disk_temperature_c,
  };
}

function subsRange(name: string, value: unknown, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `mcp.subscriptions.${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`,
    );
  }
}

const SUBS_KEYS = new Set<string>([
  'enabled',
  'retention_days',
  'max_rows',
  'cleanup_interval_s',
  'read_limit_default',
  'read_limit_max',
  'max_uris_per_listen',
  'max_listeners_per_principal',
  'max_listeners_per_process',
  'max_pending_per_stream',
  'keepalive_ms',
  'coalesce_ms',
  'progress',
  'capacity',
  'nfs_lock_threshold',
  'disk_temperature_c',
]);
const CAPACITY_KEYS = new Set<string>([
  'warning_enter',
  'warning_clear',
  'critical_enter',
  'critical_clear',
]);

function checkCapacityRules(prefix: string, t: CapacityThresholds): void {
  if (t.warning_clear >= t.warning_enter)
    throw new Error(`${prefix}: warning_clear must be < warning_enter`);
  if (t.critical_clear >= t.critical_enter)
    throw new Error(`${prefix}: critical_clear must be < critical_enter`);
  if (t.critical_enter <= t.warning_enter)
    throw new Error(`${prefix}: critical_enter must be > warning_enter`);
}

/** S17 §10 / SUBS-CONFIG-002: invalid bounds fail at load, before any listener exists. */
function validateSubscriptionsSection(config: ApiConfig): void {
  const c = config.mcp?.subscriptions;
  if (c === undefined) return;
  for (const key of Object.keys(c)) {
    if (!SUBS_KEYS.has(key)) throw new Error(`mcp.subscriptions: unknown key ${key}`);
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    throw new Error('mcp.subscriptions.enabled must be a boolean');
  }
  subsRange('retention_days', c.retention_days, 1, 30);
  subsRange('max_rows', c.max_rows, 10_000, 1_000_000);
  subsRange('cleanup_interval_s', c.cleanup_interval_s, 60, 86_400);
  subsRange('read_limit_default', c.read_limit_default, 1, 500);
  subsRange('read_limit_max', c.read_limit_max, 1, 500);
  subsRange('max_uris_per_listen', c.max_uris_per_listen, 1, 6);
  subsRange('max_listeners_per_principal', c.max_listeners_per_principal, 1, 64);
  subsRange('max_listeners_per_process', c.max_listeners_per_process, 1, 1024);
  subsRange('max_pending_per_stream', c.max_pending_per_stream, 16, 4096);
  subsRange('keepalive_ms', c.keepalive_ms, 1000, 60_000);
  subsRange('coalesce_ms', c.coalesce_ms, 0, 5000);
  if (c.progress !== undefined) {
    for (const key of Object.keys(c.progress)) {
      if (!['bucket_pct', 'min_interval_s', 'max_silence_s'].includes(key)) {
        throw new Error(`mcp.subscriptions.progress: unknown key ${key}`);
      }
    }
    subsRange('progress.bucket_pct', c.progress.bucket_pct, 1, 50);
    subsRange('progress.min_interval_s', c.progress.min_interval_s, 1, 3600);
    subsRange('progress.max_silence_s', c.progress.max_silence_s, 1, 86_400);
  }
  if (c.capacity !== undefined) {
    const { per_filesystem, ...rest } = c.capacity;
    for (const key of Object.keys(rest)) {
      if (!CAPACITY_KEYS.has(key))
        throw new Error(`mcp.subscriptions.capacity: unknown key ${key}`);
      subsRange(`capacity.${key}`, (rest as Record<string, unknown>)[key], 1, 100);
    }
    if (per_filesystem !== undefined) {
      if (
        typeof per_filesystem !== 'object' ||
        per_filesystem === null ||
        Array.isArray(per_filesystem)
      ) {
        throw new Error(
          'mcp.subscriptions.capacity.per_filesystem must be an object keyed by mount unit',
        );
      }
      for (const [fsId, o] of Object.entries(per_filesystem)) {
        if (typeof o !== 'object' || o === null || Array.isArray(o)) {
          throw new Error(`mcp.subscriptions.capacity.per_filesystem[${fsId}] must be an object`);
        }
        for (const key of Object.keys(o)) {
          if (!CAPACITY_KEYS.has(key)) {
            throw new Error(
              `mcp.subscriptions.capacity.per_filesystem[${fsId}]: unknown key ${key}`,
            );
          }
          subsRange(
            `capacity.per_filesystem[${fsId}].${key}`,
            (o as Record<string, unknown>)[key],
            1,
            100,
          );
        }
      }
    }
  }
  if (c.nfs_lock_threshold !== undefined) {
    for (const key of Object.keys(c.nfs_lock_threshold)) {
      if (key !== 'enter' && key !== 'clear') {
        throw new Error(`mcp.subscriptions.nfs_lock_threshold: unknown key ${key}`);
      }
    }
    subsRange('nfs_lock_threshold.enter', c.nfs_lock_threshold.enter, 0, 1_000_000);
    subsRange('nfs_lock_threshold.clear', c.nfs_lock_threshold.clear, 0, 1_000_000);
  }
  if (c.disk_temperature_c !== undefined && c.disk_temperature_c !== null) {
    if (
      typeof c.disk_temperature_c !== 'number' ||
      !Number.isInteger(c.disk_temperature_c) ||
      c.disk_temperature_c < 1 ||
      c.disk_temperature_c > 150
    ) {
      throw new Error(
        'mcp.subscriptions.disk_temperature_c must be an integer in [1, 150] or null',
      );
    }
  }

  // Cross-field rules run over the RESOLVED values so a partial override is
  // checked against the defaults it will actually run with.
  const r = resolveSubscriptionsConfig(config);
  if (r.read_limit_max < r.read_limit_default) {
    throw new Error('mcp.subscriptions.read_limit_max must be >= read_limit_default');
  }
  if (r.progress.max_silence_s < r.progress.min_interval_s) {
    throw new Error('mcp.subscriptions.progress.max_silence_s must be >= min_interval_s');
  }
  checkCapacityRules('mcp.subscriptions.capacity', r.capacity);
  for (const [fsId, o] of Object.entries(r.capacity.per_filesystem)) {
    checkCapacityRules(`mcp.subscriptions.capacity.per_filesystem[${fsId}]`, {
      ...r.capacity,
      ...o,
    });
  }
  if (r.nfs_lock_threshold.enter > 0 && r.nfs_lock_threshold.clear >= r.nfs_lock_threshold.enter) {
    throw new Error('mcp.subscriptions.nfs_lock_threshold: clear must be < enter when enabled');
  }
}

// ── S19 §12.1 — mcp.health_prompt ───────────────────────────────────────────

export type ProbePolicy = 'observe_only' | 'bounded_active';

/** Budgets the prompt reports; xiNAS enforces only the two probe counters (spec §9.5). */
export interface HealthPromptLimits {
  analysis_seconds: number;
  tool_calls: number;
  roles: number;
  /** Exactly 1: one probe in flight per agent, any kind. */
  active_probes_per_node: 1;
  probes_per_run: number;
  retries: number;
  run_ttl_seconds: number;
}

/** Every field optional; defaults in HEALTH_PROMPT_DEFAULTS. */
export interface McpHealthPromptConfig {
  enabled?: boolean;
  /** Operator override of the prompt body (spec §12.1); absolute path. */
  template_path?: string;
  policy_version?: string;
  probe_policy_max?: ProbePolicy;
  limits?: Partial<HealthPromptLimits>;
  baseline?: {
    profiles_dir?: string;
    timeout_s?: Partial<Record<'quick' | 'standard' | 'deep', number>>;
    max_age_s_default?: number;
  };
}

export interface ResolvedHealthPromptConfig {
  enabled: boolean;
  template_path: string | null;
  policy_version: string;
  probe_policy_max: ProbePolicy;
  limits: HealthPromptLimits;
  baseline: {
    profiles_dir: string;
    timeout_s: { quick: number; standard: number; deep: number };
    max_age_s_default: number;
  };
}

export const HEALTH_PROMPT_DEFAULTS: ResolvedHealthPromptConfig = {
  enabled: true,
  template_path: null,
  policy_version: '1',
  probe_policy_max: 'observe_only',
  limits: {
    analysis_seconds: 180,
    tool_calls: 40,
    roles: 3,
    active_probes_per_node: 1,
    probes_per_run: 4,
    retries: 2,
    run_ttl_seconds: 900,
  },
  baseline: {
    profiles_dir: '/opt/xiNAS/healthcheck_profiles',
    timeout_s: { quick: 60, standard: 180, deep: 300 },
    max_age_s_default: 0,
  },
};

export function resolveHealthPromptConfig(config: ApiConfig): ResolvedHealthPromptConfig {
  const c = config.mcp?.health_prompt ?? {};
  const d = HEALTH_PROMPT_DEFAULTS;
  const limits = c.limits ?? {};
  const baseline = c.baseline ?? {};
  return {
    enabled: c.enabled ?? d.enabled,
    template_path: c.template_path ?? d.template_path,
    policy_version: c.policy_version ?? d.policy_version,
    probe_policy_max: c.probe_policy_max ?? d.probe_policy_max,
    limits: {
      analysis_seconds: limits.analysis_seconds ?? d.limits.analysis_seconds,
      tool_calls: limits.tool_calls ?? d.limits.tool_calls,
      roles: limits.roles ?? d.limits.roles,
      active_probes_per_node: 1,
      probes_per_run: limits.probes_per_run ?? d.limits.probes_per_run,
      retries: limits.retries ?? d.limits.retries,
      run_ttl_seconds: limits.run_ttl_seconds ?? d.limits.run_ttl_seconds,
    },
    baseline: {
      profiles_dir: baseline.profiles_dir ?? d.baseline.profiles_dir,
      timeout_s: { ...d.baseline.timeout_s, ...(baseline.timeout_s ?? {}) },
      max_age_s_default: baseline.max_age_s_default ?? d.baseline.max_age_s_default,
    },
  };
}

function hpRange(name: string, value: unknown, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `mcp.health_prompt.${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`,
    );
  }
}

const HP_KEYS = new Set<string>([
  'enabled',
  'template_path',
  'policy_version',
  'probe_policy_max',
  'limits',
  'baseline',
]);
const HP_LIMIT_KEYS = new Set<string>([
  'analysis_seconds',
  'tool_calls',
  'roles',
  'active_probes_per_node',
  'probes_per_run',
  'retries',
  'run_ttl_seconds',
]);
const HP_BASELINE_KEYS = new Set<string>(['profiles_dir', 'timeout_s', 'max_age_s_default']);
const HP_PROFILE_KEYS = new Set<string>(['quick', 'standard', 'deep']);

/**
 * S19 §12.1: a bad value fails at load, before any listener exists. None
 * of these keys can lower a rank, bypass mcp.allow_apply or confirmation,
 * or change the validator (CFG-04) — they bound text, budgets and paths.
 */
export function validateHealthPromptSection(config: ApiConfig): void {
  const c = config.mcp?.health_prompt;
  if (c === undefined) return;
  for (const key of Object.keys(c)) {
    if (!HP_KEYS.has(key)) throw new Error(`mcp.health_prompt: unknown key ${key}`);
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
    throw new Error('mcp.health_prompt.enabled must be a boolean');
  }
  if (c.template_path !== undefined) {
    if (typeof c.template_path !== 'string' || !c.template_path.startsWith('/')) {
      throw new Error('mcp.health_prompt.template_path must be an absolute path');
    }
  }
  if (c.policy_version !== undefined) {
    if (typeof c.policy_version !== 'string' || !/^[A-Za-z0-9.+-]{1,32}$/.test(c.policy_version)) {
      throw new Error(
        'mcp.health_prompt.policy_version must match ^[A-Za-z0-9.+-]{1,32}$ (no spaces)',
      );
    }
  }
  if (
    c.probe_policy_max !== undefined &&
    c.probe_policy_max !== 'observe_only' &&
    c.probe_policy_max !== 'bounded_active'
  ) {
    throw new Error(
      "mcp.health_prompt.probe_policy_max must be 'observe_only' or 'bounded_active'",
    );
  }
  if (c.limits !== undefined) {
    for (const key of Object.keys(c.limits)) {
      if (!HP_LIMIT_KEYS.has(key)) throw new Error(`mcp.health_prompt.limits: unknown key ${key}`);
    }
    hpRange('limits.analysis_seconds', c.limits.analysis_seconds, 30, 3600);
    hpRange('limits.tool_calls', c.limits.tool_calls, 5, 500);
    hpRange('limits.roles', c.limits.roles, 1, 8);
    hpRange('limits.active_probes_per_node', c.limits.active_probes_per_node, 1, 1);
    hpRange('limits.probes_per_run', c.limits.probes_per_run, 0, 16);
    hpRange('limits.retries', c.limits.retries, 0, 5);
    hpRange('limits.run_ttl_seconds', c.limits.run_ttl_seconds, 300, 7200);
  }
  if (c.baseline !== undefined) {
    for (const key of Object.keys(c.baseline)) {
      if (!HP_BASELINE_KEYS.has(key)) {
        throw new Error(`mcp.health_prompt.baseline: unknown key ${key}`);
      }
    }
    if (c.baseline.profiles_dir !== undefined) {
      if (typeof c.baseline.profiles_dir !== 'string' || !c.baseline.profiles_dir.startsWith('/')) {
        throw new Error('mcp.health_prompt.baseline.profiles_dir must be an absolute path');
      }
    }
    if (c.baseline.timeout_s !== undefined) {
      for (const key of Object.keys(c.baseline.timeout_s)) {
        if (!HP_PROFILE_KEYS.has(key)) {
          throw new Error(`mcp.health_prompt.baseline.timeout_s: unknown key ${key}`);
        }
        hpRange(
          `baseline.timeout_s.${key}`,
          (c.baseline.timeout_s as Record<string, unknown>)[key],
          10,
          900,
        );
      }
    }
    hpRange('baseline.max_age_s_default', c.baseline.max_age_s_default, 0, 3600);
  }
}
