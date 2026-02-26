/**
 * Typed wrappers for xiRAID gRPC drive operations.
 *
 * References:
 *   gRPC/protobuf/message_drive.proto
 *   gRPC_server_handler/drive.py
 */

import type * as grpc from '@grpc/grpc-js';
import { callRpc, type XRaidResponse } from './responseParser';

export interface DriveFaultyCountShowRequest {
  drives?: string[];   // empty = all drives
  name?: string;       // show only drives belonging to this RAID
}

export interface DriveFaultyCountResetRequest {
  drives?: string[];   // empty = all drives
}

export interface DriveLocateRequest {
  /**
   * Block device paths to illuminate.
   * Pass an empty array [] to turn off all LEDs.
   * Reference: gRPC_server_handler/drive.py:drive_locate_handler
   */
  drives: string[];
}

export interface DriveCleanRequest {
  /**
   * Block device paths to wipe metadata and reset fault counter.
   * DESTRUCTIVE — clears xiRAID metadata from drive.
   */
  drives: string[];
}

export const driveFaultyCountShow = (
  client: grpc.Client,
  req: DriveFaultyCountShowRequest
): Promise<XRaidResponse> =>
  callRpc(client.driveFaultyCountShow.bind(client), req);

export const driveFaultyCountReset = (
  client: grpc.Client,
  req: DriveFaultyCountResetRequest
): Promise<XRaidResponse> =>
  callRpc(client.driveFaultyCountReset.bind(client), req);

export const driveLocate = (
  client: grpc.Client,
  req: DriveLocateRequest
): Promise<XRaidResponse> =>
  callRpc(client.driveLocate.bind(client), req);

export const driveClean = (
  client: grpc.Client,
  req: DriveCleanRequest
): Promise<XRaidResponse> =>
  callRpc(client.driveClean.bind(client), req);
