import { existsSync, readFileSync } from 'node:fs';

/**
 * S19c (spec §12.2): where the Python baseline engine lives and where its
 * profiles are. `profiles_dir` is the realpath allow-list `health.baseline`
 * enforces — the agent never runs a profile outside it (§8.3).
 */
export interface HealthBaselineConfig {
  python: string;
  module_root: string;
  log_dir: string;
  profiles_dir: string;
}

export const HEALTH_BASELINE_DEFAULTS: HealthBaselineConfig = {
  python: '/opt/xiNAS/venv/bin/python3',
  module_root: '/opt/xiNAS',
  log_dir: '/var/log/xinas/healthcheck',
  profiles_dir: '/opt/xiNAS/healthcheck_profiles',
};

const HEALTH_BASELINE_KEYS: ReadonlyArray<keyof HealthBaselineConfig> = [
  'python',
  'module_root',
  'log_dir',
  'profiles_dir',
];

/** Merge the optional `health_baseline` block over the defaults; a bad value is fatal, naming the key. */
export function resolveHealthBaselineConfig(raw: unknown): HealthBaselineConfig {
  if (raw === undefined) return { ...HEALTH_BASELINE_DEFAULTS };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('health_baseline must be an object');
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!(HEALTH_BASELINE_KEYS as readonly string[]).includes(key)) {
      throw new Error(`health_baseline: unknown key ${key}`);
    }
  }
  const out = { ...HEALTH_BASELINE_DEFAULTS };
  for (const key of HEALTH_BASELINE_KEYS) {
    const value = block[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw new Error(`health_baseline.${key} must be an absolute path`);
    }
    out[key] = value;
  }
  return out;
}

export interface AgentConfig {
  api_socket: string; // api UDS the agent POSTs observations to
  agent_socket: string; // the agent's own UDS it serves RPC on
  socket_group: string; // group to chown the agent socket to (xinas-api)
  controller_id: string; // resolved from controller_id_path
  agent_token: string; // internal bearer, resolved from agent_token_path
  nfs_helper_socket?: string; // nfs-helper UDS override (default /run/xinas-nfs-helper.sock)
  /** S19c: the baseline engine (always resolved; defaults when the file has no block). */
  health_baseline: HealthBaselineConfig;
}

/** What callers may hand in inline: everything resolved except the optional S19c block. */
export type AgentConfigInput = Omit<AgentConfig, 'health_baseline'> & {
  health_baseline?: Partial<HealthBaselineConfig>;
};

interface AgentConfigFile {
  api_socket: string;
  agent_socket: string;
  controller_id_path: string;
  agent_token_path: string;
  socket_group: string;
  nfs_helper_socket?: string;
  health_baseline?: unknown;
}

const DEFAULT_PATH = '/etc/xinas-agent/config.json';

export function loadAgentConfig(
  opts: { configPath?: string; inline?: AgentConfigInput } = {},
): AgentConfig {
  if (opts.inline !== undefined) {
    return {
      ...opts.inline,
      health_baseline: resolveHealthBaselineConfig(opts.inline.health_baseline),
    };
  }
  const path = opts.configPath ?? DEFAULT_PATH;
  if (!existsSync(path)) {
    throw new Error(`xinas-agent config not found at ${path}`);
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as AgentConfigFile;
  if (!existsSync(file.controller_id_path)) {
    throw new Error(`controller-id file not found at ${file.controller_id_path}`);
  }
  if (!existsSync(file.agent_token_path)) {
    throw new Error(`agent-token file not found at ${file.agent_token_path}`);
  }
  return {
    api_socket: file.api_socket,
    agent_socket: file.agent_socket,
    socket_group: file.socket_group,
    controller_id: readFileSync(file.controller_id_path, 'utf8').trim(),
    agent_token: readFileSync(file.agent_token_path, 'utf8').trim(),
    // Optional nfs-helper UDS override (tests point it at a stub helper);
    // omitted (not undefined) when absent, per exactOptionalPropertyTypes.
    ...(typeof file.nfs_helper_socket === 'string'
      ? { nfs_helper_socket: file.nfs_helper_socket }
      : {}),
    health_baseline: resolveHealthBaselineConfig(file.health_baseline),
  };
}
