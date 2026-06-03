/**
 * agent.version RPC handler.
 *
 * Returns build metadata.  git_sha and build_date are optional;
 * when absent they are NOT present in the response object at all
 * (exactOptionalPropertyTypes: no undefined placeholders).
 */

export interface VersionHandlerOptions {
  version: string;
  gitSha?: string;
  buildDate?: string;
}

export type RpcHandler = (params: unknown) => unknown;

export function makeVersionHandler(opts: VersionHandlerOptions): RpcHandler {
  return function versionHandler(_params: unknown): unknown {
    return {
      version: opts.version,
      ...(opts.gitSha !== undefined ? { git_sha: opts.gitSha } : {}),
      ...(opts.buildDate !== undefined ? { build_date: opts.buildDate } : {}),
    };
  };
}
