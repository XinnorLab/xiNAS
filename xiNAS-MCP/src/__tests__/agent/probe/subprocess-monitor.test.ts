import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // Poll until the lines arrive: `node` cold-start can exceed any fixed
    // sleep budget on a loaded machine.
    await vi.waitFor(
      () => {
        expect(lines).toContain('line1');
        expect(lines).toContain('line2');
      },
      { timeout: 10_000, interval: 25 },
    );
  }, 15_000);

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
    // Needs >=2 real `node` cold-starts plus 50ms backoffs; poll for the
    // restart instead of racing a fixed sleep under full-suite CPU load.
    await vi.waitFor(() => expect(restartCount).toBeGreaterThanOrEqual(2), {
      timeout: 10_000,
      interval: 25,
    });
  }, 15_000);

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
    // Poll for the first line so the test isn't vacuous when cold-start is slow.
    await vi.waitFor(() => expect(startCount).toBeGreaterThanOrEqual(1), {
      timeout: 10_000,
      interval: 25,
    });
    const countBefore = startCount;
    await handle.stop();
    // Negative check: a fixed window is the only way to assert "nothing more".
    await new Promise((r) => setTimeout(r, 300));
    expect(startCount).toBe(countBefore);
  }, 15_000);
});
