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
  /**
   * S2.1 worker pool (s2-task-envelope-spec §5.3). `max_inflight` caps the
   * tasks concurrently in flight end-to-end (dispatch → terminal); the
   * default (4) is applied where consumed (TaskEngine), so the whole section
   * may be omitted.
   */
  tasks?: { max_inflight?: number };
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
