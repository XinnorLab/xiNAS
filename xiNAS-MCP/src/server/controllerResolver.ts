/**
 * Resolve controller_id to gRPC endpoint and NFS socket path.
 * For v1 (single-node), always resolves to local instance.
 */

import { loadConfig, getHostname } from '../config/serverConfig.js';
import type { ControllerInfo } from '../types/common.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import { readNetConfig } from '../grpc/client.js';

export function resolveController(controllerId?: string): ControllerInfo {
  const config = loadConfig();
  const localId = config.controller_id;

  // Accept either local controller_id or undefined (default to local)
  if (controllerId && controllerId !== localId) {
    throw new McpToolError(
      ErrorCode.NOT_FOUND,
      `Unknown controller_id: ${controllerId}. This server manages: ${localId}`
    );
  }

  const netCfg = readNetConfig();
  return {
    controller_id: localId,
    hostname: getHostname(),
    grpc_endpoint: `${netCfg.host}:${netCfg.port}`,
    nfs_socket: config.nfs_helper_socket,
  };
}
