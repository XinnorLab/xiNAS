/**
 * Typed wrappers for xiRAID gRPC drive operations.
 * References: gRPC/protobuf/message_drive.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface DriveFaultyCountShowRequest {
  drives?: string[];
  name?: string;
}

export interface DriveFaultyCountResetRequest {
  drives?: string[];
}

export interface DriveLocateRequest {
  drives: string[];
}

export interface DriveCleanRequest {
  drives: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const driveFaultyCountShow = (client: GrpcClient, req: DriveFaultyCountShowRequest): Promise<XRaidResponse> =>
  callRpc(client.driveFaultyCountShow.bind(client), req);

export const driveFaultyCountReset = (client: GrpcClient, req: DriveFaultyCountResetRequest): Promise<XRaidResponse> =>
  callRpc(client.driveFaultyCountReset.bind(client), req);

export const driveLocate = (client: GrpcClient, req: DriveLocateRequest): Promise<XRaidResponse> =>
  callRpc(client.driveLocate.bind(client), req);

export const driveClean = (client: GrpcClient, req: DriveCleanRequest): Promise<XRaidResponse> =>
  callRpc(client.driveClean.bind(client), req);
