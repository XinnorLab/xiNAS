import { describe, expect, it } from 'vitest';
import {
  type HelperExportEntry,
  NfsHelperError,
  createNfsHelperClient,
} from '../../../agent/task/nfs-helper-client.js';

type Envelope = { ok: boolean; result?: unknown; code?: string; error?: string };

/**
 * Fake one-shot round-trip: records the request it was handed and returns a
 * canned envelope. Lets every NfsHelperClient method be asserted hermetically,
 * without a socket.
 */
function fakeRoundTrip(envelope: Envelope) {
  const calls: unknown[] = [];
  const roundTrip = async (req: unknown): Promise<Envelope> => {
    calls.push(req);
    return envelope;
  };
  return { roundTrip, calls };
}

describe('NfsHelperClient', () => {
  it('addExport sends add_export with the entry and create_path, resolves on ok', async () => {
    const { roundTrip, calls } = fakeRoundTrip({ ok: true });
    const client = createNfsHelperClient(roundTrip);

    const entry: HelperExportEntry = {
      path: '/mnt/data',
      clients: [{ host: '*', options: ['rw'] }],
    };
    await expect(client.addExport(entry, { create_path: true })).resolves.toBeUndefined();

    expect(calls).toEqual([
      {
        op: 'add_export',
        entry: { path: '/mnt/data', clients: [{ host: '*', options: ['rw'] }] },
        create_path: true,
      },
    ]);
  });

  it('addExport omits create_path/path_mode when not requested (exactOptional)', async () => {
    const { roundTrip, calls } = fakeRoundTrip({ ok: true });
    const client = createNfsHelperClient(roundTrip);

    const entry: HelperExportEntry = {
      path: '/mnt/data',
      clients: [{ host: '*', options: ['rw'] }],
    };
    await client.addExport(entry);

    expect(calls).toEqual([{ op: 'add_export', entry }]);
    expect(calls[0]).not.toHaveProperty('create_path');
    expect(calls[0]).not.toHaveProperty('path_mode');
  });

  it('addExport forwards path_mode when given alongside create_path', async () => {
    const { roundTrip, calls } = fakeRoundTrip({ ok: true });
    const client = createNfsHelperClient(roundTrip);

    const entry: HelperExportEntry = {
      path: '/mnt/data',
      clients: [{ host: '*', options: ['rw'] }],
    };
    await client.addExport(entry, { create_path: true, path_mode: '0755' });

    expect(calls).toEqual([{ op: 'add_export', entry, create_path: true, path_mode: '0755' }]);
  });

  it('removeExport sends remove_export with the path', async () => {
    const { roundTrip, calls } = fakeRoundTrip({ ok: true });
    const client = createNfsHelperClient(roundTrip);

    await expect(client.removeExport('/mnt/data')).resolves.toBeUndefined();
    expect(calls).toEqual([{ op: 'remove_export', path: '/mnt/data' }]);
  });

  it('updateExport sends update_export with the path and clients patch', async () => {
    const { roundTrip, calls } = fakeRoundTrip({ ok: true });
    const client = createNfsHelperClient(roundTrip);

    const clients: HelperExportEntry['clients'] = [
      { host: '10.0.0.0/24', options: ['rw', 'sync'] },
    ];
    await expect(client.updateExport('/mnt/data', { clients })).resolves.toBeUndefined();
    expect(calls).toEqual([{ op: 'update_export', path: '/mnt/data', patch: { clients } }]);
  });

  it('setIdmapDomain sends set_idmapd_domain with the domain', async () => {
    const { roundTrip, calls } = fakeRoundTrip({ ok: true });
    const client = createNfsHelperClient(roundTrip);

    await expect(client.setIdmapDomain('x.example.com')).resolves.toBeUndefined();
    expect(calls).toEqual([{ op: 'set_idmapd_domain', domain: 'x.example.com' }]);
  });

  it('listExports sends list_exports and returns the parsed result array', async () => {
    const result: HelperExportEntry[] = [
      { path: '/mnt/data', clients: [{ host: '*', options: ['rw'] }] },
    ];
    const { roundTrip, calls } = fakeRoundTrip({ ok: true, result });
    const client = createNfsHelperClient(roundTrip);

    await expect(client.listExports()).resolves.toEqual(result);
    expect(calls).toEqual([{ op: 'list_exports' }]);
  });

  it('maps {ok:false, code} to a typed NfsHelperError carrying the code and message', async () => {
    const { roundTrip } = fakeRoundTrip({
      ok: false,
      code: 'NOT_FOUND',
      error: 'no such export',
    });
    const client = createNfsHelperClient(roundTrip);

    await expect(client.removeExport('/mnt/missing')).rejects.toMatchObject({
      name: 'NfsHelperError',
      code: 'NOT_FOUND',
    });
    await expect(client.removeExport('/mnt/missing')).rejects.toBeInstanceOf(NfsHelperError);
    await expect(client.removeExport('/mnt/missing')).rejects.toThrow(/no such export/);
  });

  it('defaults the error code to INTERNAL and supplies a message when the helper omits them', async () => {
    const { roundTrip } = fakeRoundTrip({ ok: false });
    const client = createNfsHelperClient(roundTrip);

    const err = await client.listExports().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NfsHelperError);
    expect((err as NfsHelperError).code).toBe('INTERNAL');
    expect((err as NfsHelperError).message.length).toBeGreaterThan(0);
  });
});
