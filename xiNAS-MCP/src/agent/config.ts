import { existsSync, readFileSync } from 'node:fs';

export interface AgentConfig {
  api_socket: string; // api UDS the agent POSTs observations to
  agent_socket: string; // the agent's own UDS it serves RPC on
  socket_group: string; // group to chown the agent socket to (xinas-api)
  controller_id: string; // resolved from controller_id_path
  agent_token: string; // internal bearer, resolved from agent_token_path
  nfs_helper_socket?: string; // nfs-helper UDS override (default /run/xinas-nfs-helper.sock)
}

interface AgentConfigFile {
  api_socket: string;
  agent_socket: string;
  controller_id_path: string;
  agent_token_path: string;
  socket_group: string;
  nfs_helper_socket?: string;
}

const DEFAULT_PATH = '/etc/xinas-agent/config.json';

export function loadAgentConfig(
  opts: { configPath?: string; inline?: AgentConfig } = {},
): AgentConfig {
  if (opts.inline !== undefined) return opts.inline;
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
  };
}
