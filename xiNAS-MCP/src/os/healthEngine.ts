/**
 * Health-engine subprocess bridge.
 *
 * Invokes `python3 -m xinas_menu.health <profile> <log_dir> --json --no-save`
 * and parses the JSON output.  Follows the configHistory.ts subprocess pattern.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpToolError, ErrorCode } from '../types/common.js';

const PYTHON = 'python3';
const MODULE = 'xinas_menu.health';

/** Profile-specific timeouts matching healthcheck_profiles/*.yml timeout_seconds */
const PROFILE_TIMEOUT_MS: Record<string, number> = {
  quick: 60_000,
  standard: 300_000,
  deep: 600_000,
};

/** Directories to search for profile YAML files (same order as runner.py) */
const PROFILE_DIRS = [
  '/opt/xiNAS/healthcheck_profiles',
  '/home/xinnor/xiNAS/healthcheck_profiles',
];

export interface EngineCheckResult {
  section: string;
  name: string;
  status: string;  // PASS, WARN, FAIL, SKIP
  actual: string;
  expected: string;
  evidence: string;
  impact: string;
  fix_hint: string;
}

export interface EngineReport {
  metadata: {
    profile: string;
    hostname: string;
    timestamp: string;
    duration: string;
    description: string;
  };
  overall: string;
  summary: { pass: number; warn: number; fail: number; skip: number };
  checks: EngineCheckResult[];
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function findProfilePath(profile: string): string {
  for (const dir of PROFILE_DIRS) {
    for (const ext of ['.yml', '.yaml']) {
      const p = join(dir, `${profile}${ext}`);
      if (existsSync(p)) return p;
    }
  }
  throw new McpToolError(
    ErrorCode.NOT_FOUND,
    `Health check profile '${profile}' not found in ${PROFILE_DIRS.join(', ')}`,
  );
}

function run(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, ['-m', MODULE, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err && 'killed' in err && err.killed) {
        reject(new McpToolError(ErrorCode.TIMEOUT, `Health engine timed out after ${timeoutMs}ms`));
        return;
      }
      const exitCode = err && 'code' in err ? (err.code as number) : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });
}

/**
 * Run the Python health engine with the given profile and return the parsed report.
 */
export async function runEngineCheck(profile: 'quick' | 'standard' | 'deep'): Promise<EngineReport> {
  const profilePath = findProfilePath(profile);
  const timeoutMs = PROFILE_TIMEOUT_MS[profile] ?? 300_000;

  const result = await run(
    [profilePath, '/tmp', '--json', '--no-save'],
    timeoutMs,
  );

  if (result.exitCode !== 0) {
    throw new McpToolError(
      ErrorCode.INTERNAL,
      `Health engine exited with code ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`,
    );
  }

  try {
    return JSON.parse(result.stdout) as EngineReport;
  } catch {
    throw new McpToolError(
      ErrorCode.INTERNAL,
      `Failed to parse health engine output: ${result.stdout.slice(0, 200)}`,
    );
  }
}
