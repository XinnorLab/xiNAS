import { afterEach, describe, expect, it } from 'vitest';
import { type MonitorHandle, startMonitor } from '../../../agent/probe/subprocess-monitor.js';

describe('startMonitor', () => {
  const handles: MonitorHandle[] = [];
  afterEach(async () => {
    for (const h of handles) await h.stop();
    handles.length = 0;
  });

  it('emits stdout lines to onLine callback', async () => {
    const lines: string[] = [];
    const handle = startMonitor({
      cmd: 'node',
      args: ['-e', `process.stdout.write("line1\\nline2\\n"); setTimeout(()=>{},60000);`],
      onLine: (l) => lines.push(l),
      onError: () => {},
      backoffMs: [50, 100, 200],
    });
    handles.push(handle);
    // allow the process to emit lines
    await new Promise((r) => setTimeout(r, 300));
    expect(lines).toContain('line1');
    expect(lines).toContain('line2');
  });

  it('restarts the subprocess on exit and calls onLine again', async () => {
    let restartCount = 0;
    const lines: string[] = [];
    const handle = startMonitor({
      cmd: 'node',
      args: ['-e', `process.stdout.write("alive\\n"); process.exit(0);`],
      onLine: (l) => {
        if (l === 'alive') restartCount++;
        lines.push(l);
      },
      onError: () => {},
      backoffMs: [50, 50, 50],
    });
    handles.push(handle);
    // Generous window: needs >=2 real `node` cold-starts plus 50ms backoffs.
    // 500ms is borderline (~507ms observed) and flakes under full-suite
    // parallel CPU load; 1500ms gives comfortable margin without slowing
    // the suite meaningfully (the assertion fires as soon as it's reached).
    await new Promise((r) => setTimeout(r, 1500));
    expect(restartCount).toBeGreaterThanOrEqual(2);
  });

  it('stop() terminates the subprocess and prevents further restarts', async () => {
    let startCount = 0;
    const handle = startMonitor({
      cmd: 'node',
      args: ['-e', `process.stdout.write("tick\\n"); setTimeout(()=>{},60000);`],
      onLine: () => {
        startCount++;
      },
      onError: () => {},
      backoffMs: [50, 50, 50],
    });
    handles.push(handle);
    await new Promise((r) => setTimeout(r, 100));
    const countBefore = startCount;
    await handle.stop();
    await new Promise((r) => setTimeout(r, 300));
    // no new lines after stop
    expect(startCount).toBe(countBefore);
  });
});
