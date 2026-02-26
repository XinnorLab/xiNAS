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
}

export type NfsOp =
  | 'list_exports'
  | 'add_export'
  | 'remove_export'
  | 'update_export'
  | 'list_sessions'
  | 'get_sessions'
  | 'set_quota'
  | 'reload';

export interface NfsRequest {
  op: NfsOp;
  request_id: string;
  entry?: ExportEntry;
  path?: string;
  patch?: Partial<ExportEntry>;
  quota?: QuotaSpec;
}

export interface NfsResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  request_id: string;
}
