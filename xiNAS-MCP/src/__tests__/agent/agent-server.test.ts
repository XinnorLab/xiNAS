/**
 * Layer 3 smoke test: boots a real agent process on an ephemeral UDS,
 * sends agent.health, verifies the response shape, then shuts down.
 *
 * The agent reads its config from env vars overriding the file paths
 * (XINAS_AGENT_CONFIG_PATH) so no real /etc or /var paths are touched.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..'); // -> xiNAS-MCP
const AGENT_ENTRY = join(PROJECT_ROOT, 'dist/agent-server.js');

// Helper: wait until a UDS socket file appears (up to timeoutMs).
function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (existsSync(socketPath)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`socket ${socketPath} never appeared`));
      setTimeout(check, 100);
    };
    check();
  });
}

// Helper: send one JSON-RPC request and return the parsed response.
function rpcCall(socketPath: string, req: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(req) + '\n');
    });
    let buf = '';
    client.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        client.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => reject(new Error('rpcCall timeout')), 4000);
  });
}

describe('agent-server process smoke test', () => {
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];

  // CI runs `npm test` without a prior build; production runs the
  // compiled artifact. Build on demand if dist/agent-server.js is absent
  // so the smoke test exercises the real compiled entry in every env.
  beforeAll(() => {
    if (!existsSync(AGENT_ENTRY)) {
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
  }, 180_000);

  afterEach(async () => {
    for (const p of procs.splice(0)) {
      // A test may have already SIGTERM'd the process and consumed its
      // 'exit' event (the SIGTERM case). Attaching a fresh 'exit' listener
      // then would hang forever, so only wait when it is still running.
      if (p.exitCode === null && p.signalCode === null) {
        await new Promise<void>((res) => {
          p.once('exit', () => res());
          p.kill('SIGTERM');
        });
      }
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('boots, binds the UDS socket, and answers agent.health', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-e2e-'));
    dirs.push(dir);

    const sockPath = join(dir, 'agent.sock');
    const ctrlIdPath = join(dir, 'controller-id');
    const tokenPath = join(dir, 'agent-token');
    const configPath = join(dir, 'config.json');

    writeFileSync(ctrlIdPath, '00000000-0000-0000-0000-000000000099\n');
    writeFileSync(tokenPath, 'test-agent-token\n');
    writeFileSync(
      configPath,
      JSON.stringify({
        api_socket: join(dir, 'api.sock'), // api won't be present; agent just reads config
        agent_socket: sockPath,
        controller_id_path: ctrlIdPath,
        agent_token_path: tokenPath,
        socket_group: 'nogroup', // gid 65534 on Linux; agent skips chown on error
      }),
    );

    const proc = spawn(process.execPath, [AGENT_ENTRY], {
      env: { ...process.env, XINAS_AGENT_CONFIG_PATH: configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(proc);

    // Collect stderr for diagnostics on failure.
    const stderrLines: string[] = [];
    proc.stderr?.on('data', (c: Buffer) => stderrLines.push(c.toString()));
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        // Process exited prematurely — log stderr for diagnosis.
        process.stderr.write('agent stderr:\n' + stderrLines.join(''));
      }
    });

    await waitForSocket(sockPath);

    const response = (await rpcCall(sockPath, {
      jsonrpc: '2.0',
      id: 1,
      method: 'agent.health',
      params: {},
    })) as Record<string, unknown>;

    expect(response['result']).toBeDefined();
    const result = response['result'] as Record<string, unknown>;
    expect(result['version']).toBeDefined();
    expect(result['controller_id']).toBe('00000000-0000-0000-0000-000000000099');
    expect(result['in_flight_tasks']).toBe(0);
    expect(result['collectors']).toBeDefined();
  });

  it('shuts down cleanly on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xinas-agent-sigterm-'));
    dirs.push(dir);

    const sockPath = join(dir, 'agent.sock');
    const ctrlIdPath = join(dir, 'controller-id');
    const tokenPath = join(dir, 'agent-token');
    const configPath = join(dir, 'config.json');

    writeFileSync(ctrlIdPath, '00000000-0000-0000-0000-00000000aabb\n');
    writeFileSync(tokenPath, 'test-token\n');
    writeFileSync(
      configPath,
      JSON.stringify({
        api_socket: join(dir, 'api.sock'),
        agent_socket: sockPath,
        controller_id_path: ctrlIdPath,
        agent_token_path: tokenPath,
        socket_group: 'nogroup',
      }),
    );

    const proc = spawn(process.execPath, [AGENT_ENTRY], {
      env: { ...process.env, XINAS_AGENT_CONFIG_PATH: configPath },
      stdio: 'ignore',
    });
    procs.push(proc);

    await waitForSocket(sockPath);

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.once('exit', (code) => resolve(code));
      proc.kill('SIGTERM');
    });

    // Node processes exit with 0 on clean SIGTERM handler.
    expect(exitCode).toBe(0);
  });
});
