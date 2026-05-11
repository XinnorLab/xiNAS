/**
 * NFS helper daemon types.
 */

export interface ExportEntry {
  path: string;
  clients: ClientSpec[];
}

export interface ClientSpec {
  host: string;
  options: string[];
}

export interface SessionInfo {
  client_ip: string;
  export_path: string;
  nfs_version: string;
  active_locks?: number;
}

export interface QuotaSpec {
  path: string;
  type: 'user' | 'group' | 'project';
  soft_limit_kb: number;
  hard_limit_kb: number;
  project_id?: number;
  // When set, the helper takes the user-quota branch (xfs_quota -u <username>).
  // Required for type='user'; ignored otherwise.
  username?: string;
}

export type NfsOp =
  | 'list_exports'
  | 'add_export'
  | 'remove_export'
  | 'update_export'
  | 'list_sessions'
  | 'get_sessions'
  | 'set_quota'
  | 'reload'
  | 'fix_nfs_conf';

export interface NfsConfFixRequest {
  threads?: number | 'auto';
  rdma?: boolean | string;
  updates?: Record<string, Record<string, string | number | boolean>>;
  restart?: boolean;
}

export interface NfsConfFixChange {
  section: string;
  key: string;
  old: string;
  new: string;
  action: 'updated' | 'inserted' | 'unchanged';
}

export interface NfsConfFixResult {
  applied: NfsConfFixChange[];
  changed: boolean;
  restarted: boolean;
  restart_error: string;
}

export interface NfsRequest {
  op: NfsOp;
  request_id: string;
  entry?: ExportEntry;
  path?: string;
  patch?: Partial<ExportEntry>;
  quota?: QuotaSpec;
  threads?: number | 'auto';
  rdma?: boolean | string;
  updates?: Record<string, Record<string, string | number | boolean>>;
  restart?: boolean;
  // add_export: when true, mkdir the export path if missing (single level; parent must exist)
  create_path?: boolean;
  // add_export: octal mode string (e.g. "0755", "1777") for the created directory
  path_mode?: string;
}

export interface NfsResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  request_id: string;
}
