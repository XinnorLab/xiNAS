/**
 * Typed wrappers for xiRAID gRPC settings operations.
 * References: gRPC/protobuf/message_settings.proto
 * All read-only — used by system.get_status and system.get_controller_capabilities.
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const settingsAuthShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsAuthShow.bind(client), {});

export const settingsFaultyCountShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsFaultyCountShow.bind(client), {});

export const settingsLogShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsLogShow.bind(client), {});

export const settingsMailShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsMailShow.bind(client), {});

export const settingsPoolShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsPoolShow.bind(client), {});

export const settingsScannerShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsScannerShow.bind(client), {});

export const settingsClusterShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.settingsClusterShow.bind(client), {});
