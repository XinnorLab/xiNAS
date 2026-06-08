/**
 * Unit tests for the four real NFS executors (S3 N3.2,
 * s3-nfs-executor-spec §3.1–3.3, §3.5).
 *
 * Drives each executor exactly as the {@link TaskRunner} does — call each
 * `stage.run(ctx)` in order, then `executor.rollback(ctx)`, sharing the one
 * `ctx` (so the preflight-captured prior state in `ctx.stash` reaches
 * rollback). A FAKE {@link NfsHelperClient} records every call and is
 * scriptable (canned `listExports` result + a one-shot throw), and
 * `readIdmapDomain` is a plain async stub — no socket, no helper process.
 */
import { describe, expect, it } from 'vitest';
import { buildNfsExecutors, type NfsExecutorDeps } from '../../../agent/task/nfs-executor.js';
import {
  type AddExportOptions,
  type HelperExportEntry,
  NfsHelperError,
  type NfsHelperClient,
} from '../../../agent/task/nfs-helper-client.js';
import type { Executor, ExecutorContext } from '../../../agent/task/types.js';

/** A recorded call against the fake helper (op name + the call arguments). */
interface RecordedCall {
  op: 'listExports' | 'addExport' | 'removeExport' | 'updateExport' | 'setIdmapDomain';
  args: unknown[];
}

interface FakeHelper extends NfsHelperClient {
  calls: RecordedCall[];
  /** Canned result returned by listExports(). */
  listResult: HelperExportEntry[];
  /** When set, the next call to this op throws the given error (one-shot). */
  throwOn: { op: RecordedCall['op']; error: Error } | undefined;
  /** Honor a scripted one-shot throw, then record the call. */
  record(op: RecordedCall['op'], args: unknown[]): void;
}

function makeFakeHelper(listResult: HelperExportEntry[] = []): FakeHelper {
  const calls: RecordedCall[] = [];
  const fake: FakeHelper = {
    calls,
    listResult,
    throwOn: undefined,
    record(op: RecordedCall['op'], args: unknown[]): void {
      // Honor a scripted one-shot throw before recording the (failed) call.
      if (fake.throwOn && fake.throwOn.op === op) {
        const err = fake.throwOn.error;
        fake.throwOn = undefined;
        calls.push({ op, args });
        throw err;
      }
      calls.push({ op, args });
    },
    async listExports(): Promise<HelperExportEntry[]> {
      fake.record('listExports', []);
      return fake.listResult;
    },
    async addExport(entry: HelperExportEntry, opts?: AddExportOptions): Promise<void> {
      fake.record('addExport', [entry, opts]);
    },
    async removeExport(path: string): Promise<void> {
      fake.record('removeExport', [path]);
    },
    async updateExport(
      path: string,
      patch: { clients: HelperExportEntry['clients'] },
    ): Promise<void> {
      fake.record('updateExport', [path, patch]);
    },
    async setIdmapDomain(domain: string): Promise<void> {
      fake.record('setIdmapDomain', [domain]);
    },
  };
  return fake;
}

/** Minimal fake ExecutorContext with a writable `stash` (shared across stages). */
function makeCtx(spec: unknown): ExecutorContext {
  return {
    spec,
    emitOutput(): void {},
    isCancelRequested(): boolean {
      return false;
    },
    stash: {},
  };
}

function getExecutor(deps: NfsExecutorDeps, kind: string): Executor {
  const ex = buildNfsExecutors(deps).find((e) => e.operation_kind === kind);
  if (!ex) throw new Error(`no executor for ${kind}`);
  return ex;
}

function stage(ex: Executor, name: string) {
  const s = ex.stages.find((st) => st.name === name);
  if (!s) throw new Error(`no stage ${name} on ${ex.operation_kind}`);
  return s;
}

/** Deps with a no-op readIdmapDomain unless overridden. */
function makeDeps(
  helper: NfsHelperClient,
  readIdmapDomain: () => Promise<string | undefined> = async () => undefined,
): NfsExecutorDeps {
  return { helper, readIdmapDomain };
}

describe('buildNfsExecutors — registration', () => {
  it('returns exactly the four expected operation kinds', () => {
    const list = buildNfsExecutors(makeDeps(makeFakeHelper()));
    expect(list.map((e) => e.operation_kind).sort()).toEqual(
      ['nfs-idmap.set', 'share.create', 'share.delete', 'share.update'].sort(),
    );
  });
});

describe('share.create', () => {
  const spec = {
    id: 's1',
    path: '/mnt/data',
    fsid: '42',
    clients: [{ pattern: '10.0.0.0/24', options: ['rw'] }],
  };

  it('apply calls addExport with the compiled entry + create_path:true', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);

    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);

    const addCall = helper.calls.find((c) => c.op === 'addExport');
    expect(addCall).toBeDefined();
    const [entry, opts] = addCall?.args as [HelperExportEntry, AddExportOptions];
    // Compiled entry: path preserved, client folded with default tokens.
    expect(entry.path).toBe('/mnt/data');
    expect(entry.clients[0]?.host).toBe('10.0.0.0/24');
    expect(entry.clients[0]?.options).toContain('rw');
    expect(entry.clients[0]?.options).toContain('no_subtree_check'); // hardening default
    expect(opts.create_path).toBe(true);
    expect(opts.path_mode).toBe('0755');
  });

  it('preflight throws EXPORT_PATH_IN_USE when listExports already has the path', async () => {
    const helper = makeFakeHelper([{ path: '/mnt/data', clients: [] }]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await expect(stage(ex, 'preflight').run(ctx)).rejects.toThrow(/EXPORT_PATH_IN_USE/);
    // It must NOT proceed to addExport.
    expect(helper.calls.some((c) => c.op === 'addExport')).toBe(false);
  });

  it('verify passes when listExports contains the path', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.listResult = [{ path: '/mnt/data', clients: [] }];
    await expect(stage(ex, 'verify').run(ctx)).resolves.toBeUndefined();
  });

  it('verify throws when listExports does NOT contain the path', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.listResult = []; // still absent
    await expect(stage(ex, 'verify').run(ctx)).rejects.toThrow();
  });

  it('rollback calls removeExport(path)', async () => {
    const helper = makeFakeHelper([]);
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    await ex.rollback(ctx);
    const rm = helper.calls.find((c) => c.op === 'removeExport');
    expect(rm).toBeDefined();
    expect(rm?.args[0]).toBe('/mnt/data');
  });

  it('rollback swallows NOT_FOUND (apply never wrote the export) — idempotent', async () => {
    const helper = makeFakeHelper([]);
    helper.throwOn = {
      op: 'removeExport',
      error: new NfsHelperError('NOT_FOUND', 'no such export'),
    };
    const ex = getExecutor(makeDeps(helper), 'share.create');
    // rollback must NOT throw — the line was never committed, so undo is complete.
    await expect(ex.rollback(makeCtx(spec))).resolves.toBeUndefined();
  });

  it('rollback rethrows a non-NOT_FOUND helper error', async () => {
    const helper = makeFakeHelper([]);
    helper.throwOn = {
      op: 'removeExport',
      error: new NfsHelperError('INTERNAL', 'exportfs failed'),
    };
    const ex = getExecutor(makeDeps(helper), 'share.create');
    await expect(ex.rollback(makeCtx(spec))).rejects.toThrow(/exportfs failed/);
  });
});

describe('share.update', () => {
  const spec = {
    id: 's1',
    path: '/mnt/data',
    clients: [{ pattern: '10.0.0.0/24', options: ['ro'] }],
  };
  const priorEntry: HelperExportEntry = {
    path: '/mnt/data',
    clients: [{ host: '10.0.0.0/24', options: ['rw', 'no_subtree_check'] }],
  };

  it('preflight stashes the prior entry for the path', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorEntry).toEqual(priorEntry);
  });

  it('preflight stashes null when the path is absent', async () => {
    const helper = makeFakeHelper([]); // no entry for the path
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorEntry).toBeNull();
  });

  it('apply calls updateExport(path, {clients}) with the compiled clients', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    const up = helper.calls.find((c) => c.op === 'updateExport');
    expect(up).toBeDefined();
    expect(up?.args[0]).toBe('/mnt/data');
    const patch = up?.args[1] as { clients: HelperExportEntry['clients'] };
    expect(patch.clients[0]?.host).toBe('10.0.0.0/24');
    expect(patch.clients[0]?.options).toContain('ro');
  });

  it('rollback restores prior clients via updateExport(path, {clients: prior})', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0; // isolate rollback calls
    await ex.rollback(ctx);
    const up = helper.calls.find((c) => c.op === 'updateExport');
    expect(up).toBeDefined();
    expect(up?.args[0]).toBe('/mnt/data');
    const patch = up?.args[1] as { clients: HelperExportEntry['clients'] };
    expect(patch.clients).toEqual(priorEntry.clients);
  });

  it('rollback is a no-op when prior entry was absent', async () => {
    const helper = makeFakeHelper([]); // absent at preflight
    const ex = getExecutor(makeDeps(helper), 'share.update');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    expect(helper.calls.some((c) => c.op === 'updateExport')).toBe(false);
  });
});

describe('share.delete', () => {
  const spec = { id: 's1', path: '/mnt/data' };
  const priorEntry: HelperExportEntry = {
    path: '/mnt/data',
    clients: [{ host: '10.0.0.0/24', options: ['rw'] }],
  };

  it('preflight stashes the prior entry', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorEntry).toEqual(priorEntry);
  });

  it('apply calls removeExport(path)', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    const rm = helper.calls.find((c) => c.op === 'removeExport');
    expect(rm).toBeDefined();
    expect(rm?.args[0]).toBe('/mnt/data');
  });

  it('apply swallows a NfsHelperError(NOT_FOUND) as already-done', async () => {
    const helper = makeFakeHelper([priorEntry]);
    helper.throwOn = { op: 'removeExport', error: new NfsHelperError('NOT_FOUND', 'gone') };
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await expect(stage(ex, 'apply').run(ctx)).resolves.toBeUndefined();
  });

  it('apply rethrows a non-NOT_FOUND helper error', async () => {
    const helper = makeFakeHelper([priorEntry]);
    helper.throwOn = { op: 'removeExport', error: new NfsHelperError('INTERNAL', 'boom') };
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await expect(stage(ex, 'apply').run(ctx)).rejects.toThrow(/boom/);
  });

  it('rollback re-adds the stashed prior entry via addExport(prior)', async () => {
    const helper = makeFakeHelper([priorEntry]);
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    const add = helper.calls.find((c) => c.op === 'addExport');
    expect(add).toBeDefined();
    expect((add?.args[0] as HelperExportEntry).path).toBe('/mnt/data');
    expect((add?.args[0] as HelperExportEntry).clients).toEqual(priorEntry.clients);
  });

  it('rollback is a no-op when there was no prior entry', async () => {
    const helper = makeFakeHelper([]); // absent at preflight
    helper.throwOn = { op: 'removeExport', error: new NfsHelperError('NOT_FOUND', 'gone') };
    const ex = getExecutor(makeDeps(helper), 'share.delete');
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    expect(helper.calls.some((c) => c.op === 'addExport')).toBe(false);
  });
});

describe('nfs-idmap.set', () => {
  const spec = { domain: 'new.example.com' };

  it('preflight stashes the prior domain via readIdmapDomain', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => 'old.example.com'),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    expect(ctx.stash.priorDomain).toBe('old.example.com');
  });

  it('apply calls setIdmapDomain(domain)', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => 'old.example.com'),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    const set = helper.calls.find((c) => c.op === 'setIdmapDomain');
    expect(set).toBeDefined();
    expect(set?.args[0]).toBe('new.example.com');
  });

  it('rollback restores the prior domain via setIdmapDomain(prior)', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => 'old.example.com'),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    const set = helper.calls.find((c) => c.op === 'setIdmapDomain');
    expect(set).toBeDefined();
    expect(set?.args[0]).toBe('old.example.com');
  });

  it('rollback is a no-op when the prior domain was unset', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(
      makeDeps(helper, async () => undefined),
      'nfs-idmap.set',
    );
    const ctx = makeCtx(spec);
    await stage(ex, 'preflight').run(ctx);
    await stage(ex, 'apply').run(ctx);
    helper.calls.length = 0;
    await ex.rollback(ctx);
    expect(helper.calls.some((c) => c.op === 'setIdmapDomain')).toBe(false);
  });
});

describe('spec narrowing', () => {
  it('share.create preflight throws a clear error on a malformed spec', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'share.create');
    const ctx = makeCtx({ id: 's1' }); // missing path/clients
    await expect(stage(ex, 'preflight').run(ctx)).rejects.toThrow();
  });

  it('nfs-idmap.set apply throws a clear error when domain is missing', async () => {
    const helper = makeFakeHelper();
    const ex = getExecutor(makeDeps(helper), 'nfs-idmap.set');
    const ctx = makeCtx({}); // no domain
    await expect(stage(ex, 'preflight').run(ctx)).resolves.toBeUndefined();
    await expect(stage(ex, 'apply').run(ctx)).rejects.toThrow();
  });
});
