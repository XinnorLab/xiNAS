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

// ── S9 T1 (ADR-0011): read + reset verbs + the projection table ──────────────

import {
  type HistoryManifest,
  projectSnapshot,
} from '../../../agent/task/xinas-history-bridge.js';

const MANIFESTS: HistoryManifest[] = [
  {
    id: '20260101T000000Z-baseline',
    timestamp: '2026-01-01T00:00:00Z',
    user: 'root',
    source: 'installer',
    status: 'valid',
    type: 'baseline',
    rollback_class: 'destroying_data',
  },
  {
    id: '20260601T120000Z-raid-create',
    timestamp: '2026-06-01T12:00:00Z',
    user: 'admin:demo',
    source: 'mcp',
    status: 'valid',
    type: 'rollback_eligible',
    operation: 'raid_create',
    rollback_class: 'changing_access',
    diff_summary: 'created array data1',
  },
  {
    id: '20260601T115900Z-pre',
    timestamp: '2026-06-01T11:59:00Z',
    user: 'admin:demo',
    source: 'mcp',
    status: 'valid',
    type: 'ephemeral',
  },
];

describe('S9 bridge verbs', () => {
  it('snapshotList: argv + array parsing + row filtering', async () => {
    const calls: string[][] = [];
    const bridge = new XinasHistoryBridge({
      runSubprocess: async (argv) => {
        calls.push(argv);
        return { stdout: JSON.stringify([...MANIFESTS, { not: 'a manifest' }]), code: 0 };
      },
    });
    const rows = await bridge.snapshotList();
    expect(calls[0]).toEqual([
      'python3',
      '-m',
      'xinas_history',
      'snapshot',
      'list',
      '--format',
      'json',
    ]);
    expect(rows).toHaveLength(3); // the malformed row is filtered
    expect(rows[0]?.id).toBe('20260101T000000Z-baseline');
  });

  it('snapshotDiff: argv + passthrough; non-zero exit throws', async () => {
    const bridge = new XinasHistoryBridge({
      runSubprocess: async (argv) => {
        expect(argv.slice(3)).toEqual(['snapshot', 'diff', 'a', 'b', '--format', 'json']);
        return { stdout: '{"from_id":"a","to_id":"b","config_changes":[]}', code: 0 };
      },
    });
    expect(await bridge.snapshotDiff('a', 'b')).toMatchObject({ from_id: 'a' });

    const failing = new XinasHistoryBridge({
      runSubprocess: async () => ({ stdout: 'boom', code: 1 }),
    });
    await expect(failing.snapshotDiff('a', 'b')).rejects.toThrow(/exited with code 1/);
  });

  it('resetToBaseline: argv carries --reason and --yes; success surfaces', async () => {
    const calls: string[][] = [];
    const bridge = new XinasHistoryBridge({
      runSubprocess: async (argv) => {
        calls.push(argv);
        return { stdout: JSON.stringify({ success: true, snapshot_id: 'pre-1' }), code: 0 };
      },
    });
    const result = await bridge.resetToBaseline('demo reset');
    expect(result.success).toBe(true);
    expect(calls[0]).toContain('reset-to-baseline');
    expect(calls[0]).toContain('--reason');
    expect(calls[0]).toContain('demo reset');
    expect(calls[0]).toContain('--yes');
  });
});

describe('projectSnapshot (the ADR-0011 projection table)', () => {
  it('maps history types onto the public kind enum, fields typed top-level', () => {
    const [baseline, after, before] = MANIFESTS.map(projectSnapshot);
    expect(baseline).toMatchObject({
      snapshot_id: '20260101T000000Z-baseline',
      kind: 'baseline',
      created_at: '2026-01-01T00:00:00Z',
      principal: 'root',
      rollback_classification: 'destroying_data',
      history_type: 'baseline',
    });
    expect(after?.kind).toBe('after');
    expect(after?.operation).toBe('raid_create');
    expect(after?.diff_summary).toBe('created array data1');
    expect(before?.kind).toBe('before');
    expect(before?.operation).toBeNull();
    // forward-compat: unknown type → imported
    expect(projectSnapshot({ id: 'x', timestamp: 't', type: 'wild' }).kind).toBe('imported');
    expect(projectSnapshot({ id: 'x', timestamp: 't' }).kind).toBe('imported');
  });
});
