/**
 * Typed wrappers for xiRAID gRPC config operations.
 * References: gRPC/protobuf/message_config.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface ConfigBackupRequest {
  path?: string;
}

export interface ConfigRestoreRequest {
  path?: string;
  all?: boolean;
}

export interface ConfigShowRequest {
  drives?: string[];
}

export interface ConfigApplyRequest {
  path?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const configBackup = (client: GrpcClient, req: ConfigBackupRequest): Promise<XRaidResponse> =>
  callRpc(client.configBackup.bind(client), req);

export const configRestore = (client: GrpcClient, req: ConfigRestoreRequest): Promise<XRaidResponse> =>
  callRpc(client.configRestore.bind(client), req);

export const configShow = (client: GrpcClient, req: ConfigShowRequest): Promise<XRaidResponse> =>
  callRpc(client.configShow.bind(client), req);

export const configApply = (client: GrpcClient, req: ConfigApplyRequest): Promise<XRaidResponse> =>
  callRpc(client.configApply.bind(client), req);
