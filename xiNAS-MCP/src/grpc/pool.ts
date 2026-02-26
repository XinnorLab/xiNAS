/**
 * Typed wrappers for xiRAID gRPC spare pool operations.
 * References: gRPC/protobuf/message_pool.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface PoolCreateRequest { name: string; drives: string[] }
export interface PoolDeleteRequest { name: string }
export interface PoolAddRequest { name: string; drives: string[] }
export interface PoolRemoveRequest { name: string; drives: string[] }
export interface PoolShowRequest { name?: string; units?: string }
export interface PoolActivateRequest { name: string }
export interface PoolDeactivateRequest { name: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const poolCreate = (client: GrpcClient, req: PoolCreateRequest): Promise<XRaidResponse> =>
  callRpc(client.poolCreate.bind(client), req);

export const poolDelete = (client: GrpcClient, req: PoolDeleteRequest): Promise<XRaidResponse> =>
  callRpc(client.poolDelete.bind(client), req);

export const poolAdd = (client: GrpcClient, req: PoolAddRequest): Promise<XRaidResponse> =>
  callRpc(client.poolAdd.bind(client), req);

export const poolRemove = (client: GrpcClient, req: PoolRemoveRequest): Promise<XRaidResponse> =>
  callRpc(client.poolRemove.bind(client), req);

export const poolShow = (client: GrpcClient, req: PoolShowRequest): Promise<XRaidResponse> =>
  callRpc(client.poolShow.bind(client), req);

export const poolActivate = (client: GrpcClient, req: PoolActivateRequest): Promise<XRaidResponse> =>
  callRpc(client.poolActivate.bind(client), req);

export const poolDeactivate = (client: GrpcClient, req: PoolDeactivateRequest): Promise<XRaidResponse> =>
  callRpc(client.poolDeactivate.bind(client), req);
