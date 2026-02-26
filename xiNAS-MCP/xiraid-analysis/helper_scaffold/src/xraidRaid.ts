/**
 * Typed wrappers for xiRAID gRPC RAID operations.
 *
 * Each function corresponds to one RPC in XRAIDService.
 * Message schemas are derived from message_raid.proto.
 *
 * References:
 *   gRPC/protobuf/message_raid.proto
 *   gRPC_server_handler/raid/create.py, destroy.py, modify.py,
 *     init.py, recon.py, restripe.py, show.py, unload.py, restore.py
 */

import type * as grpc from '@grpc/grpc-js';
import { callRpc, type XRaidResponse } from './responseParser';

// --- Message types (mirror message_raid.proto) ---

export interface RaidCreateRequest {
  name: string;
  level: string;
  drives: string[];
  group_size?: number;       // required for levels 50/60/70; range 2–32
  synd_cnt?: number;         // for N+M levels; range 4–32
  strip_size?: number;       // KiB; from STRIP_SIZES_KB constant
  block_size?: number;       // 512 or 4096
  sparepool?: string;
  init_prio?: number;        // 1–100
  recon_prio?: number;       // 1–100
  restripe_prio?: number;    // 1–100
  sched_enabled?: number;    // 0 or 1
  merge_read_enabled?: number;
  merge_write_enabled?: number;
  memory_limit?: number;     // MiB; 1024–1048576, or 0
  request_limit?: number;    // 0–INT_MAX
  force_metadata?: boolean;  // overwrite existing drive metadata (admin only)
  max_sectors_kb?: number;   // 4–4096, or 0
  merge_read_max?: number;   // microseconds
  merge_read_wait?: number;
  merge_write_max?: number;
  merge_write_wait?: number;
  cpu_allowed?: string;      // CPU affinity mask e.g. "0-3,8"
  adaptive_merge?: number;   // 0 or 1
  single_run?: boolean;
  adaptive_merge_path?: string;
  memory_prealloc?: number;  // MiB; 1024–65536, or 0
  sdc_prio?: number;         // 1–100
  discard?: number;
  drive_trim?: number;
  force?: boolean;           // admin only
}

export interface RaidDestroyRequest {
  name?: string;
  all?: boolean;
  force?: boolean;           // admin only — bypasses state checks
  config_only?: boolean;     // remove from config only, don't unload kernel
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
  force_online?: boolean;    // admin — force online despite unrecoverable sections
  force_resync?: boolean;    // admin — force re-initialization
  force?: boolean;
  max_sectors_kb?: number;
  merge_read_max?: number;
  merge_read_wait?: number;
  merge_write_max?: number;
  merge_write_wait?: number;
  cpu_allowed?: string;
  adaptive_merge?: number;
  single_run?: boolean;
  adaptive_merge_path?: string;
  memory_prealloc?: number;
  sdc_prio?: number;
  discard?: number;
  discard_ignore?: number;
  discard_verify?: number;
  drive_write_through?: number;
}

export interface RaidShowRequest {
  name?: string;
  extended?: boolean;        // include per-drive and progress details
  active?: boolean;          // only show loaded RAIDs
  units?: string;            // 's'|'k'|'m'|'g'|'t'
}

export interface RaidUnloadRequest {
  name?: string;
  all?: boolean;
}

export interface RaidRestoreRequest {
  name?: string;
  all?: boolean;
  service?: boolean;         // internal flag — do not set
}

export interface RaidInitStartRequest { name: string }
export interface RaidInitStopRequest { name: string }
export interface RaidInitResetRequest { name: string }
export interface RaidInitForceFinishedRequest { name: string; force?: boolean }

export interface RaidReconStartRequest { name: string }
export interface RaidReconStopRequest { name: string }
export interface RaidReconForceFinishedRequest { name: string; force?: boolean }

export interface RaidRestripeStartRequest {
  name: string;
  level: string;
  drives: string[];
  group_size?: number;
}
export interface RaidRestripeContinueRequest { name: string }
export interface RaidRestripeStopRequest { name: string }
export interface RaidRestripeForceFinishedRequest { name: string; force?: boolean }

export interface RaidReplaceRequest {
  name: string;
  number: number;            // drive slot index
  drive: string;             // new block device path
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

export interface RaidDefaultsShowRequest {
  level: string;
  strip_size?: number;
  drives?: number;
  drive_type?: string;       // 'slow'|'middle'|'fast'
}

// --- Wrapper functions ---

export const raidShow = (client: grpc.Client, req: RaidShowRequest): Promise<XRaidResponse> =>
  callRpc(client.raidShow.bind(client), req);

export const raidCreate = (client: grpc.Client, req: RaidCreateRequest): Promise<XRaidResponse> =>
  callRpc(client.raidCreate.bind(client), req);

export const raidDestroy = (client: grpc.Client, req: RaidDestroyRequest): Promise<XRaidResponse> =>
  callRpc(client.raidDestroy.bind(client), req);

export const raidModify = (client: grpc.Client, req: RaidModifyRequest): Promise<XRaidResponse> =>
  callRpc(client.raidModify.bind(client), req);

export const raidUnload = (client: grpc.Client, req: RaidUnloadRequest): Promise<XRaidResponse> =>
  callRpc(client.raidUnload.bind(client), req);

export const raidRestore = (client: grpc.Client, req: RaidRestoreRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestore.bind(client), req);

export const raidInitStart = (client: grpc.Client, req: RaidInitStartRequest): Promise<XRaidResponse> =>
  callRpc(client.raidInitStart.bind(client), req);

export const raidInitStop = (client: grpc.Client, req: RaidInitStopRequest): Promise<XRaidResponse> =>
  callRpc(client.raidInitStop.bind(client), req);

export const raidInitReset = (client: grpc.Client, req: RaidInitResetRequest): Promise<XRaidResponse> =>
  callRpc(client.raidInitReset.bind(client), req);

export const raidInitForceFinished = (client: grpc.Client, req: RaidInitForceFinishedRequest): Promise<XRaidResponse> =>
  callRpc(client.raidInitForceFinished.bind(client), req);

export const raidReconStart = (client: grpc.Client, req: RaidReconStartRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReconStart.bind(client), req);

export const raidReconStop = (client: grpc.Client, req: RaidReconStopRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReconStop.bind(client), req);

export const raidReconForceFinished = (client: grpc.Client, req: RaidReconForceFinishedRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReconForceFinished.bind(client), req);

export const raidRestripeStart = (client: grpc.Client, req: RaidRestripeStartRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeStart.bind(client), req);

export const raidRestripeContinue = (client: grpc.Client, req: RaidRestripeContinueRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeContinue.bind(client), req);

export const raidRestripeStop = (client: grpc.Client, req: RaidRestripeStopRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeStop.bind(client), req);

export const raidRestripeForceFinished = (client: grpc.Client, req: RaidRestripeForceFinishedRequest): Promise<XRaidResponse> =>
  callRpc(client.raidRestripeForceFinished.bind(client), req);

export const raidReplace = (client: grpc.Client, req: RaidReplaceRequest): Promise<XRaidResponse> =>
  callRpc(client.raidReplace.bind(client), req);

export const raidResize = (client: grpc.Client, req: RaidResizeRequest): Promise<XRaidResponse> =>
  callRpc(client.raidResize.bind(client), req);

export const raidImportShow = (client: grpc.Client, req: RaidImportShowRequest): Promise<XRaidResponse> =>
  callRpc(client.raidImportShow.bind(client), req);

export const raidImportApply = (client: grpc.Client, req: RaidImportApplyRequest): Promise<XRaidResponse> =>
  callRpc(client.raidImportApply.bind(client), req);

export const raidDefaultsShow = (client: grpc.Client, req: RaidDefaultsShowRequest): Promise<XRaidResponse> =>
  callRpc(client.raidDefaultsShow.bind(client), req);
