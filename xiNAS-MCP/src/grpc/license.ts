/**
 * Typed wrappers for xiRAID gRPC license operations.
 * References: gRPC/protobuf/message_license.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface LicenseUpdateRequest {
  key: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const licenseShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.licenseShow.bind(client), {});

export const licenseUpdate = (client: GrpcClient, req: LicenseUpdateRequest): Promise<XRaidResponse> =>
  callRpc(client.licenseUpdate.bind(client), req);

export const licenseDelete = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.licenseDelete.bind(client), {});
