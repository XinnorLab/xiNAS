import { describe, expect, it, vi } from 'vitest';
import {
  type RunSubprocess,
  XinasHistoryBridge,
} from '../../../agent/task/xinas-history-bridge.js';

describe('XinasHistoryBridge.snapshotCreate', () => {
  it('invokes python3 -m xinas_history snapshot create with --format json and parses {id}', async () => {
    const calls: string[][] = [];
    const runSubprocess: RunSubprocess = vi.fn(async (argv: string[]) => {
      calls.push(argv);
      return { stdout: JSON.stringify({ id: '20260605T120000Z-reference-echo' }), code: 0 };
    });

    const bridge = new XinasHistoryBridge({ runSubprocess });
    const result = await bridge.snapshotCreate('reference_echo', 'api');

    expect(result).toEqual({ snapshot_id: '20260605T120000Z-reference-echo' });

    expect(calls).toHaveLength(1);
    const argv = calls[0] as string[];
    // Must call the module form and pass the exact flags the CLI expects.
    expect(argv.slice(0, 3)).toEqual(['python3', '-m', 'xinas_history']);
    expect(argv).toContain('snapshot');
    expect(argv).toContain('create');
    expect(argv[argv.indexOf('--source') + 1]).toBe('api');
    expect(argv[argv.indexOf('--operation') + 1]).toBe('reference_echo');
    expect(argv[argv.indexOf('--format') + 1]).toBe('json');
  });

  it('throws on a non-zero exit code', async () => {
    const runSubprocess: RunSubprocess = async () => ({
      stdout: '',
      code: 1,
    });
    const bridge = new XinasHistoryBridge({ runSubprocess });
    await expect(bridge.snapshotCreate('reference_echo', 'api')).rejects.toThrow(/exit/i);
  });

  it('throws on unparseable stdout', async () => {
    const runSubprocess: RunSubprocess = async () => ({
      stdout: 'not json at all',
      code: 0,
    });
    const bridge = new XinasHistoryBridge({ runSubprocess });
    await expect(bridge.snapshotCreate('reference_echo', 'api')).rejects.toThrow();
  });

  it('throws when stdout JSON lacks an id field', async () => {
    const runSubprocess: RunSubprocess = async () => ({
      stdout: JSON.stringify({ not_id: 'x' }),
      code: 0,
    });
    const bridge = new XinasHistoryBridge({ runSubprocess });
    await expect(bridge.snapshotCreate('reference_echo', 'api')).rejects.toThrow(/id/i);
  });

  it('tolerates extra surrounding whitespace/newlines in stdout', async () => {
    const runSubprocess: RunSubprocess = async () => ({
      stdout: `\n  ${JSON.stringify({ id: 'snap-1' })}  \n`,
      code: 0,
    });
    const bridge = new XinasHistoryBridge({ runSubprocess });
    await expect(bridge.snapshotCreate('op', 'api')).resolves.toEqual({ snapshot_id: 'snap-1' });
  });
});
