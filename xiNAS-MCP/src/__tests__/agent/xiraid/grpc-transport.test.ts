/**
 * createGrpcTransport — the request options the real transport puts on the
 * wire. Thin by design, but two of its flags are load-bearing and invisible
 * from every other layer:
 *
 *   units: 'g'      — an unset unit crashes the daemon's formatter (#17).
 *   extended: true  — without it raid_show omits the whole tuning surface, so
 *                     spec.tuning stays permanently empty and every client
 *                     reads the array's priorities/limits as unknown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const raidShow = vi.fn(async (_client: unknown, _req: unknown) => ({ data: [] }));
const poolShow = vi.fn(async (_client: unknown, _req: unknown) => ({ data: [] }));

vi.mock('../../../grpc/client.js', () => ({ getClient: vi.fn(async () => ({})) }));
vi.mock('../../../grpc/raid.js', () => ({
  raidShow,
  raidCreate: vi.fn(),
  raidDestroy: vi.fn(),
  raidModify: vi.fn(),
  raidImportApply: vi.fn(),
  raidImportShow: vi.fn(),
}));
vi.mock('../../../grpc/pool.js', () => ({
  poolShow,
  poolActivate: vi.fn(),
  poolAdd: vi.fn(),
  poolCreate: vi.fn(),
  poolDeactivate: vi.fn(),
  poolDelete: vi.fn(),
  poolRemove: vi.fn(),
}));

const { createGrpcTransport } = await import('../../../agent/xiraid/client.js');

describe('createGrpcTransport', () => {
  beforeEach(() => {
    raidShow.mockClear();
    poolShow.mockClear();
  });

  it('raid_show asks for the extended payload (the tuning surface) in gibibytes', async () => {
    await createGrpcTransport().raidShow();
    expect(raidShow).toHaveBeenCalledTimes(1);
    expect(raidShow.mock.calls[0]?.[1]).toEqual({ units: 'g', extended: true });
  });

  it('pool_show still passes units (no extended surface there)', async () => {
    await createGrpcTransport().poolShow();
    expect(poolShow.mock.calls[0]?.[1]).toEqual({ units: 'g' });
  });
});
