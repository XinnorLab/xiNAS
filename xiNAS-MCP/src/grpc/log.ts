/**
 * Typed wrappers for xiRAID gRPC log operations.
 * References: gRPC/protobuf/message_log.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface LogShowRequest {
  count?: number;
  level?: string;
}

export interface LogCollectRequest {
  path?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const logShow = (client: GrpcClient, req: LogShowRequest): Promise<XRaidResponse> =>
  callRpc(client.logShow.bind(client), req);

export const logCollect = (client: GrpcClient, req: LogCollectRequest): Promise<XRaidResponse> =>
  callRpc(client.logCollect.bind(client), req);
