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

interface RawClient {
  host_pattern: string;
  options?: string[];
}

interface RawExport {
  path: string;
  clients?: RawClient[];
}

interface RawListExports {
  exports?: RawExport[];
}

export function parseListExports(raw: string): ObservedExportRule[] {
  const data = parseJson(raw, 'parseListExports') as RawListExports;
  const exports_ = data.exports ?? [];
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
        host_pattern: client.host_pattern,
        options: opts,
        ...(squash_mode !== undefined ? { squash_mode } : {}),
        ...(anon_uid !== undefined ? { anon_uid } : {}),
        ...(anon_gid !== undefined ? { anon_gid } : {}),
      });
    }
  }

  return rules;
}

interface RawSession {
  client_addr: string;
  export_path: string;
  proto_version: string;
  locked_files: number;
  client_hostname?: string;
}

interface RawListSessions {
  sessions?: RawSession[];
}

export function parseListSessions(raw: string): ObservedNfsSession[] {
  const data = parseJson(raw, 'parseListSessions') as RawListSessions;
  const sessions = data.sessions ?? [];

  return sessions.map<ObservedNfsSession>((s) => ({
    kind: 'NfsSession',
    id: `${s.client_addr}:${s.export_path}`,
    spec: {
      client_addr: s.client_addr,
      export_path: s.export_path,
      ...(s.client_hostname !== undefined ? { client_hostname: s.client_hostname } : {}),
    },
    status: {
      proto_version: s.proto_version,
      locked_files: s.locked_files,
    },
  }));
}
