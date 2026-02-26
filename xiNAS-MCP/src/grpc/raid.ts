/**
 * Typed wrappers for xiRAID gRPC RAID operations.
 * References: gRPC/protobuf/message_raid.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface RaidCreateRequest {
  name: string;
  level: string;
  drives: string[];
  group_size?: number;
  synd_cnt?: number;
  strip_size?: number;
  block_size?: number;
  sparepool?: string;
  init_prio?: number;
  recon_prio?: number;
  restripe_prio?: number;
  sched_enabled?: number;
  merge_read_enabled?: number;
  merge_write_enabled?: number;
  memory_limit?: number;
  request_limit?: number;
  force_metadata?: boolean;
  max_sectors_kb?: number;
  merge_read_max?: number;
  merge_read_wait?: number;
  merge_write_max?: number;
  merge_write_wait?: number;
  cpu_allowed?: string;
  adaptive_merge?: number;
  single_run?: boolean;
  memory_prealloc?: number;
  sdc_prio?: number;
  discard?: number;
  drive_trim?: number;
  force?: boolean;
}

export interface RaidDestroyRequest {
  name?: string;
  all?: boolean;
  force?: boolean;
  config_only?: boolean;
}

export interface RaidModifyRequest {
  name: string;
  sparepool?: string;
  init_prio?: number;
  recon_prio?: number;
  restripe_prio?: number;
  sched_enabled?: number;
  merge_read_enabled?: number;
  merge_write_enabled?: number;
  memory_limit?: number;
  request_limit?: number;
  force_online?: boolean;
  force_resync?: boolean;
  force?: boolean;
  max_sectors_kb?: number;
  merge_read_max?: number;
  merge_read_wait?: number;
  merge_write_max?: number;
  merge_write_wait?: number;
  cpu_allowed?: string;
  adaptive_merge?: number;
  single_run?: boolean;
  memory_prealloc?: number;
  sdc_prio?: number;
  discard?: number;
  discard_ignore?: number;
  discard_verify?: number;
  drive_write_through?: number;
}

export interface RaidShowRequest {
  name?: string;
  extended?: boolean;
  active?: boolean;
  units?: string;
}

export interface RaidUnloadRequest {
  name?: string;
  all?: boolean;
}

export interface RaidRestoreRequest {
  name?: string;
  all?: boolean;
  service?: boolean;
}

export interface RaidInitStartRequest { name: string }
export interface RaidInitStopRequest { name: string }
export interface RaidInitResetRequest { name: string }

export interface RaidReconStartRequest { name: string }
export interface RaidReconStopRequest { name: string }

export interface RaidRestripeStartRequest {
  name: string;
  level: string;
  drives: string[];
  group_size?: number;
}
export interface RaidRestripeContinueRequest { name: string }
export interface RaidRestripeStopRequest { name: string }

export interface RaidReplaceRequest {
  name: string;
  number: number;
  drive: string;
}

export interface RaidResizeRequest { name: string }

export interface RaidImportShowRequest {
  drives?: string[];
  offline?: boolean;
}
export interface RaidImportApplyRequest {
  uuid?: string;
  new_name?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const raidShow = (client: GrpcClient, req: RaidShowRequest): Promise<XRaidResponse> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  callRpc(client.raidShow.bind(client), req);

export const raidCreate = (client: GrpcClient, req: RaidCreateRequest): Promise<XRaidResponse> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  callRpc(client.raidCreate.bind(client), req);

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
export const raidDestroy = (client: GrpcClient, req: RaidDestroyRequest): Promise<XRaidResponse> =>
  callRpc(client.raidDestroy.bind(client), req);

export const raidModify = (client: GrpcClient, req: RaidModifyRequest): Promise<XRaidResponse> =>
  callRpc(client.raidModify.bind(client), req);

export const raidUnload = (client: GrpcClient, req: RaidUnloadRequest): Promise<XRaidResponse> =>
  callRpc(client.raidUnload.bind(client), req);

export const raidRestore = (client: GrpcClient, req: RaidRestoreRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestore.bind(client), req);

export const raidInitStart = (client: GrpcClient, req: RaidInitStartRequest): Promise<XRaidResponse> =>
  callRpc(client.raidInitStart.bind(client), req);

export const raidInitStop = (client: GrpcClient, req: RaidInitStopRequest): Promise<XRaidResponse> =>
  callRpc(client.raidInitStop.bind(client), req);

export const raidReconStart = (client: GrpcClient, req: RaidReconStartRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReconStart.bind(client), req);

export const raidReconStop = (client: GrpcClient, req: RaidReconStopRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReconStop.bind(client), req);

export const raidRestripeStart = (client: GrpcClient, req: RaidRestripeStartRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeStart.bind(client), req);

export const raidRestripeContinue = (client: GrpcClient, req: RaidRestripeContinueRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeContinue.bind(client), req);

export const raidRestripeStop = (client: GrpcClient, req: RaidRestripeStopRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeStop.bind(client), req);

export const raidReplace = (client: GrpcClient, req: RaidReplaceRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReplace.bind(client), req);

export const raidResize = (client: GrpcClient, req: RaidResizeRequest): Promise<XRaidResponse> =>
  callRpc(client.raidResize.bind(client), req);

export const raidImportShow = (client: GrpcClient, req: RaidImportShowRequest): Promise<XRaidResponse> =>
  callRpc(client.raidImportShow.bind(client), req);

export const raidImportApply = (client: GrpcClient, req: RaidImportApplyRequest): Promise<XRaidResponse> =>
  callRpc(client.raidImportApply.bind(client), req);
/* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
