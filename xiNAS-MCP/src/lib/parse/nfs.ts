/**
 * Pure parsers for xinas-nfs-helper list_exports / list_sessions
 * JSON output. Emits typed objects matching api-v1.yaml's ExportRule
 * and NfsSession schemas.
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ObservedExportRule {
  export_path: string;
  host_pattern: string;
  options: string[];
  squash_mode?: 'root_squash' | 'no_root_squash' | 'all_squash';
  anon_uid?: number;
  anon_gid?: number;
}

export interface ObservedNfsSession {
  kind: 'NfsSession';
  id: string;
  spec: {
    client_addr: string;
    export_path: string;
    client_hostname?: string;
  };
  status: {
    proto_version: string;
    locked_files: number;
  };
}

type SquashMode = 'root_squash' | 'no_root_squash' | 'all_squash';

function extractSquashMode(options: string[]): SquashMode | undefined {
  if (options.includes('all_squash')) return 'all_squash';
  if (options.includes('no_root_squash')) return 'no_root_squash';
  if (options.includes('root_squash')) return 'root_squash';
  return undefined;
}

function extractAnonId(options: string[], key: 'anon_uid' | 'anon_gid'): number | undefined {
  const entry = options.find((o) => o.startsWith(`${key}=`));
  if (entry === undefined) return undefined;
  const val = parseInt(entry.slice(key.length + 1), 10);
  return isNaN(val) ? undefined : val;
}

function parseJson(raw: string, caller: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${caller}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The nfs-helper wraps every response as `{ ok, result, request_id }`
 * (success) or `{ ok: false, error, code, request_id }` (failure) —
 * nfs_helper.py `handle_request`. The parsers below take the RAW response
 * JSON, so they unwrap that envelope themselves.
 */
interface HelperEnvelope {
  ok?: boolean;
  result?: unknown;
  error?: string;
}

/** One list_exports entry in the helper's wire shape: `{ path, clients:[{host, options}] }`. */
interface RawClient {
  host: string;
  options?: string[];
}

interface RawExport {
  path: string;
  clients?: RawClient[];
}

/**
 * Unwrap the helper envelope. An `ok:false` response MUST throw, not return
 * empty: the NFS collector treats a successful-but-empty sweep as "no
 * entities" and reconcile-DELETEs the observed rows for the kind, so
 * swallowing a helper error would wipe good observed state on a transient
 * failure. A throw makes the sweep fail, which skips reconcile (boot.ts).
 */
function helperResult(data: HelperEnvelope, caller: string): unknown {
  if (data.ok === false) {
    throw new Error(`${caller}: nfs-helper returned an error: ${data.error ?? 'unknown'}`);
  }
  return data.result;
}

export function parseListExports(raw: string): ObservedExportRule[] {
  const data = parseJson(raw, 'parseListExports') as HelperEnvelope;
  const exports_ = (helperResult(data, 'parseListExports') as RawExport[] | undefined) ?? [];
  const rules: ObservedExportRule[] = [];

  for (const exp of exports_) {
    const clients = exp.clients ?? [];
    for (const client of clients) {
      const opts = client.options ?? [];
      const squash_mode = extractSquashMode(opts);
      const anon_uid = extractAnonId(opts, 'anon_uid');
      const anon_gid = extractAnonId(opts, 'anon_gid');
      rules.push({
        export_path: exp.path,
        host_pattern: client.host,
        options: opts,
        ...(squash_mode !== undefined ? { squash_mode } : {}),
        ...(anon_uid !== undefined ? { anon_uid } : {}),
        ...(anon_gid !== undefined ? { anon_gid } : {}),
      });
    }
  }

  return rules;
}

/**
 * One list_sessions entry in the helper's wire shape (nfs_sessions.py):
 * `{ client_ip, nfs_version, export_path, active_locks }`. The helper does
 * not resolve a hostname or per-session lock count beyond active_locks.
 */
interface RawSession {
  client_ip: string;
  export_path: string;
  nfs_version: string;
  active_locks: number;
}

export function parseListSessions(raw: string): ObservedNfsSession[] {
  const data = parseJson(raw, 'parseListSessions') as HelperEnvelope;
  const sessions = (helperResult(data, 'parseListSessions') as RawSession[] | undefined) ?? [];

  return sessions.map<ObservedNfsSession>((s) => ({
    kind: 'NfsSession',
    id: `${s.client_ip}:${s.export_path}`,
    spec: {
      client_addr: s.client_ip,
      export_path: s.export_path,
    },
    status: {
      proto_version: s.nfs_version,
      locked_files: s.active_locks,
    },
  }));
}
