/**
 * Typed wrappers for xiRAID gRPC spare pool operations.
 *
 * References:
 *   gRPC/protobuf/message_pool.proto
 *   gRPC_server_handler/pool.py
 *   spare_pool/manager.py
 */

import type * as grpc from '@grpc/grpc-js';
import { callRpc, type XRaidResponse } from './responseParser';

export interface PoolCreateRequest {
  name: string;
  drives: string[];
}

export interface PoolDeleteRequest {
  name: string;
}

export interface PoolAddRequest {
  name: string;
  drives: string[];
}

export interface PoolRemoveRequest {
  name: string;
  drives: string[];
}

export interface PoolShowRequest {
  name?: string;      // omit for all pools
  units?: string;     // 's'|'k'|'m'|'g'|'t'
}

export interface PoolActivateRequest { name: string }
export interface PoolDeactivateRequest { name: string }

export const poolCreate = (client: grpc.Client, req: PoolCreateRequest): Promise<XRaidResponse> =>
  callRpc(client.poolCreate.bind(client), req);

export const poolDelete = (client: grpc.Client, req: PoolDeleteRequest): Promise<XRaidResponse> =>
  callRpc(client.poolDelete.bind(client), req);

export const poolAdd = (client: grpc.Client, req: PoolAddRequest): Promise<XRaidResponse> =>
  callRpc(client.poolAdd.bind(client), req);

export const poolRemove = (client: grpc.Client, req: PoolRemoveRequest): Promise<XRaidResponse> =>
  callRpc(client.poolRemove.bind(client), req);

export const poolShow = (client: grpc.Client, req: PoolShowRequest): Promise<XRaidResponse> =>
  callRpc(client.poolShow.bind(client), req);

export const poolActivate = (client: grpc.Client, req: PoolActivateRequest): Promise<XRaidResponse> =>
  callRpc(client.poolActivate.bind(client), req);

export const poolDeactivate = (client: grpc.Client, req: PoolDeactivateRequest): Promise<XRaidResponse> =>
  callRpc(client.poolDeactivate.bind(client), req);
