/**
 * Config-history subprocess bridge.
 *
 * Invokes `python3 -m xinas_history <command> --format json` and parses
 * the JSON output.  Matches the nfs-helper subprocess pattern.
 */

import { execFile } from 'node:child_process';
import { McpToolError, ErrorCode } from '../types/common.js';

const PYTHON = 'python3';
const MODULE = 'xinas_history';

/** Timeout for read-only operations (30 s) */
const READ_TIMEOUT_MS = 30_000;
/** Timeout for rollback / write operations (300 s) */
const WRITE_TIMEOUT_MS = 300_000;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, ['-m', MODULE, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && 'killed' in err && err.killed) {
        reject(new McpToolError(ErrorCode.TIMEOUT, `Config-history command timed out after ${timeoutMs}ms`));
        return;
      }
      // execFile sets err for non-zero exit but we handle it ourselves
      const exitCode = err && 'code' in err ? (err.code as number) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });
}

function parseJsonOutput(result: ExecResult): unknown {
  if (result.exitCode !== 0) {
    // Try parsing stderr as JSON error
    try {
      const errObj = JSON.parse(result.stderr) as { error?: string; code?: string };
      const code = mapErrorCode(errObj.code);
      throw new McpToolError(code, errObj.error ?? result.stderr.trim());
    } catch (e) {
      if (e instanceof McpToolError) throw e;
      throw new McpToolError(ErrorCode.INTERNAL, result.stderr.trim() || 'Config-history command failed');
    }
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new McpToolError(ErrorCode.INTERNAL, `Failed to parse config-history output: ${result.stdout.slice(0, 200)}`);
  }
}

function mapErrorCode(code?: string): ErrorCode {
  switch (code) {
    case 'NOT_FOUND': return ErrorCode.NOT_FOUND;
    case 'CONFLICT': return ErrorCode.CONFLICT;
    case 'PRECONDITION_FAILED': return ErrorCode.PRECONDITION_FAILED;
    case 'RESOURCE_EXHAUSTION': return ErrorCode.RESOURCE_EXHAUSTION;
    default: return ErrorCode.INTERNAL;
  }
}

// --- Public API ---

export async function listSnapshots(options?: { statusFilter?: string }): Promise<unknown> {
  const args = ['snapshot', 'list', '--format', 'json'];
  if (options?.statusFilter) args.push('--status', options.statusFilter);
  return parseJsonOutput(await run(args, READ_TIMEOUT_MS));
}

export async function showSnapshot(id: string): Promise<unknown> {
  return parseJsonOutput(await run(['snapshot', 'show', id, '--format', 'json'], READ_TIMEOUT_MS));
}

export async function diffSnapshots(fromId: string, toId: string): Promise<unknown> {
  return parseJsonOutput(await run(['snapshot', 'diff', fromId, toId, '--format', 'json'], READ_TIMEOUT_MS));
}

export async function checkDrift(): Promise<unknown> {
  return parseJsonOutput(await run(['status', '--format', 'json'], READ_TIMEOUT_MS));
}

export async function getStatus(): Promise<unknown> {
  return parseJsonOutput(await run(['status', '--format', 'json'], READ_TIMEOUT_MS));
}

export async function createSnapshot(operation: string, diffSummary?: string): Promise<unknown> {
  const args = ['snapshot', 'create', '--source', 'mcp', '--operation', operation, '--format', 'json'];
  if (diffSummary) args.push('--diff-summary', diffSummary);
  return parseJsonOutput(await run(args, WRITE_TIMEOUT_MS));
}

/**
 * Record a snapshot after a successful mutation.
 * Best-effort: errors are caught and returned as null.
 */
export async function recordSnapshot(operation: string, diffSummary: string): Promise<unknown | null> {
  try {
    return await createSnapshot(operation, diffSummary);
  } catch {
    // Snapshot recording should never block the primary operation
    return null;
  }
}

export async function getRetentionPolicy(): Promise<unknown> {
  return parseJsonOutput(await run(['gc', 'policy', '--format', 'json'], READ_TIMEOUT_MS));
}

export async function setRetentionPolicy(maxSnapshots?: number, maxAgeDays?: number): Promise<unknown> {
  const args = ['gc', 'policy', '--set', '--format', 'json'];
  if (maxSnapshots !== undefined) args.push('--max-snapshots', String(maxSnapshots));
  if (maxAgeDays !== undefined) args.push('--max-age-days', String(maxAgeDays));
  return parseJsonOutput(await run(args, WRITE_TIMEOUT_MS));
}
