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

export interface TokenPrincipal {
  principal: string;
  role: Role;
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
