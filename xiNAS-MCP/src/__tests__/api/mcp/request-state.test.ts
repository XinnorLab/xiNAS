import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpProtocolError } from '../../../api/mcp/confirmation/errors.js';
import {
  type KeyRing,
  type RequestStatePayload,
  REQUEST_STATE_MAX_BYTES,
  loadOrCreateKeyRing,
  mintRequestState,
  newNonce,
  nonceHash,
  verifyRequestState,
} from '../../../api/mcp/confirmation/state.js';

const payload: RequestStatePayload = {
  v: 1,
  cid: 'c-1',
  sub: 'admin:demo',
  role: 'admin',
  tool: 'shares.update',
  ah: 'a'.repeat(64),
  pid: 'plan-1',
  ph: 'b'.repeat(64),
  rev: 42,
  ik: 'idem-1',
  risk: 'changing_access',
  mode: 'form',
  iat: 1_757_000_000_000,
  exp: 1_757_000_300_000,
  nonce: 'n0nce',
  round: 1,
};

describe('requestState codec (S15 §7)', () => {
  let dir: string;
  let ring: KeyRing;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xinas-keyring-'));
    ring = loadOrCreateKeyRing(join(dir, 'keys.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a 0600 key ring with one 32-byte active key and reloads it identically', () => {
    const path = join(dir, 'keys.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ring.keys.get(ring.active)?.length).toBe(32);
    const again = loadOrCreateKeyRing(path);
    expect(again.active).toBe(ring.active);
    expect(again.keys.get(again.active)?.equals(ring.keys.get(ring.active) as Buffer)).toBe(true);
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      active: string;
      keys: Record<string, string>;
    };
    expect(Object.keys(file.keys)).toEqual([ring.active]);
  });

  it('refuses a symlinked ring and a ring readable by group or world (review P1)', () => {
    const real = join(dir, 'real.json');
    loadOrCreateKeyRing(real);
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    expect(() => loadOrCreateKeyRing(link)).toThrow(/regular file/);
    chmodSync(real, 0o640);
    expect(() => loadOrCreateKeyRing(real)).toThrow(/group\/world/);
    chmodSync(real, 0o600);
    expect(loadOrCreateKeyRing(real).active).toBe('k1');
  });

  it("a lost EEXIST race loads the other writer's ring instead of overwriting it", () => {
    const path = join(dir, 'race.json');
    const first = loadOrCreateKeyRing(path);
    // Simulate "someone created it between our check and our write": the
    // second call must find the exclusive create failing with EEXIST and
    // load first's key, never a fresh one.
    const second = loadOrCreateKeyRing(path);
    expect(second.keys.get('k1')?.equals(first.keys.get('k1') as Buffer)).toBe(true);
  });

  it('round-trips a payload through mint → verify with the xc1 prefix', () => {
    const encoded = mintRequestState(ring, payload);
    expect(encoded.startsWith(`xc1.${ring.active}.`)).toBe(true);
    expect(encoded.split('.')).toHaveLength(4);
    expect(verifyRequestState(ring, encoded)).toEqual(payload);
  });

  it('rejects every single-character alteration with the same generic error', () => {
    const encoded = mintRequestState(ring, payload);
    for (let i = 0; i < encoded.length; i += 1) {
      const ch = encoded[i] === 'A' ? 'B' : 'A';
      const tampered = encoded.slice(0, i) + ch + encoded.slice(i + 1);
      if (tampered === encoded) continue;
      let err: unknown;
      try {
        verifyRequestState(ring, tampered);
      } catch (e) {
        err = e;
      }
      expect(err, `position ${i}`).toBeInstanceOf(McpProtocolError);
      expect((err as McpProtocolError).code).toBe(-32602);
      expect((err as McpProtocolError).message).toBe('invalid request state');
    }
  });

  it('rejects a foreign key, an unknown kid, a wrong prefix, truncation, oversize and non-strings', () => {
    const other = loadOrCreateKeyRing(join(dir, 'other.json'));
    const encoded = mintRequestState(other, payload);
    expect(() => verifyRequestState(ring, encoded)).toThrow('invalid request state');
    const [, , body, mac] = mintRequestState(ring, payload).split('.');
    expect(() => verifyRequestState(ring, `xc1.nope.${body}.${mac}`)).toThrow(
      'invalid request state',
    );
    expect(() => verifyRequestState(ring, `xc2.${ring.active}.${body}.${mac}`)).toThrow(
      'invalid request state',
    );
    expect(() => verifyRequestState(ring, `xc1.${ring.active}.${body}`)).toThrow(
      'invalid request state',
    );
    expect(() => verifyRequestState(ring, 'x'.repeat(REQUEST_STATE_MAX_BYTES + 1))).toThrow(
      'invalid request state',
    );
    expect(() => verifyRequestState(ring, 42)).toThrow('invalid request state');
    expect(() => verifyRequestState(ring, undefined)).toThrow('invalid request state');
  });

  it('rejects a well-signed payload with a wrong field type or unknown version', () => {
    const bad = mintRequestState(ring, { ...payload, rev: '42' } as unknown as RequestStatePayload);
    expect(() => verifyRequestState(ring, bad)).toThrow('invalid request state');
    const badV = mintRequestState(ring, { ...payload, v: 2 } as unknown as RequestStatePayload);
    expect(() => verifyRequestState(ring, badV)).toThrow('invalid request state');
  });

  it('accepts a state minted with a retired-but-listed key and rejects one whose kid was removed', () => {
    const k0 = ring.keys.get(ring.active) as Buffer;
    const encoded = mintRequestState(ring, payload);
    const rotated: KeyRing = {
      active: 'k2',
      keys: new Map([
        ['k2', Buffer.alloc(32, 7)],
        [ring.active, k0],
      ]),
    };
    expect(verifyRequestState(rotated, encoded)).toEqual(payload);
    const removed: KeyRing = { active: 'k2', keys: new Map([['k2', Buffer.alloc(32, 7)]]) };
    expect(() => verifyRequestState(removed, encoded)).toThrow('invalid request state');
  });

  it('nonces are 22-char base64url and nonceHash is sha256 hex', () => {
    const n = newNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonceHash(n)).toMatch(/^[0-9a-f]{64}$/);
    expect(nonceHash(n)).toBe(nonceHash(n));
  });
});
