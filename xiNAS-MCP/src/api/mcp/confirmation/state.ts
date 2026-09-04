import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize } from '../../../lib/canonical-json.js';
import { invalidRequestState } from './errors.js';

/** S15 §7 — the opaque, HMAC-SHA-256-protected requestState. */
export const REQUEST_STATE_PREFIX = 'xc1';
export const REQUEST_STATE_MAX_BYTES = 4096;

export interface RequestStatePayload {
  v: 1;
  cid: string;
  sub: string;
  role: string;
  tool: string;
  ah: string;
  pid: string;
  ph: string;
  rev: number;
  ik: string;
  risk: string;
  mode: 'form' | 'url';
  iat: number;
  exp: number;
  nonce: string;
  round: number;
}

export interface KeyRing {
  active: string;
  keys: Map<string, Buffer>;
}

interface KeyRingFile {
  active: string;
  keys: Record<string, string>; // base64
}

const KID = /^[A-Za-z0-9_-]{1,16}$/;

const GROUP_OR_WORLD = 0o077;

/**
 * Exclusive, no-follow create (S15 §7.6, review P1). Returns false when the
 * path already existed — including when another actor won the race — so
 * the caller loads it. There is never an "exists, then write" window.
 */
function createExclusive(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const file: KeyRingFile = { active: 'k1', keys: { k1: randomBytes(32).toString('base64') } };
    writeSync(fd, `${JSON.stringify(file, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Refuse anything but a regular, owner-only file we own; read it without following links. */
function readRingSafely(path: string): KeyRingFile {
  const st = lstatSync(path);
  if (!st.isFile()) {
    throw new Error(`confirmation key ring ${path} must be a regular file (not a symlink)`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`confirmation key ring ${path} is owned by uid ${st.uid}, expected ${uid}`);
  }
  if ((st.mode & GROUP_OR_WORLD) !== 0) {
    throw new Error(
      `confirmation key ring ${path} mode 0${(st.mode & 0o777).toString(8)} grants group/world access; expected 0600`,
    );
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, 'utf8')) as KeyRingFile;
  } finally {
    closeSync(fd);
  }
}

/** Load the ring, creating `{ active: 'k1', keys: { k1: <32 random bytes> } }` exclusively when absent. */
export function loadOrCreateKeyRing(path: string): KeyRing {
  createExclusive(path); // false → it exists (or another writer won the race): load it
  const raw = readRingSafely(path);
  const keys = new Map<string, Buffer>();
  for (const [kid, b64] of Object.entries(raw.keys)) {
    if (!KID.test(kid))
      throw new Error(`confirmation key ring: invalid key id '${kid}' in ${path}`);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 32)
      throw new Error(`confirmation key ring: key '${kid}' is shorter than 32 bytes`);
    keys.set(kid, buf);
  }
  if (!keys.has(raw.active))
    throw new Error(`confirmation key ring: active key '${raw.active}' is not listed`);
  return { active: raw.active, keys };
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function mac(key: Buffer, body: string): Buffer {
  return createHmac('sha256', key).update(body, 'utf8').digest();
}

export function mintRequestState(ring: KeyRing, payload: RequestStatePayload): string {
  const key = ring.keys.get(ring.active);
  if (key === undefined) throw new Error('confirmation key ring has no active key');
  const body = `${REQUEST_STATE_PREFIX}.${ring.active}.${b64url(Buffer.from(canonicalize(payload), 'utf8'))}`;
  return `${body}.${b64url(mac(key, body))}`;
}

function isPayload(v: unknown): v is RequestStatePayload {
  if (v === null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  const str = (k: string) => typeof p[k] === 'string' && (p[k] as string).length > 0;
  const int = (k: string) => typeof p[k] === 'number' && Number.isInteger(p[k]);
  return (
    p.v === 1 &&
    ['cid', 'sub', 'role', 'tool', 'ah', 'pid', 'ph', 'ik', 'risk', 'nonce'].every(str) &&
    ['rev', 'iat', 'exp', 'round'].every(int) &&
    (p.mode === 'form' || p.mode === 'url')
  );
}

/**
 * Verify in the order S15 §7.4 mandates: size → format → kid → MAC
 * (constant-time) → decode → schema. Every failure is the same generic
 * -32602; the class of failure is kept on the error for the audit trail.
 */
export function verifyRequestState(ring: KeyRing, encoded: unknown): RequestStatePayload {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > REQUEST_STATE_MAX_BYTES) {
    throw invalidRequestState('size');
  }
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== REQUEST_STATE_PREFIX) throw invalidRequestState('format');
  const [, kid, body, sig] = parts as [string, string, string, string];
  if (!KID.test(kid) || body.length === 0 || sig.length === 0) throw invalidRequestState('format');
  const key = ring.keys.get(kid);
  if (key === undefined) throw invalidRequestState('kid');
  // Compare the CANONICAL base64url text of the MAC, not decoded bytes:
  // base64url without padding has trailing-bit slack, so two different last
  // characters can decode to the same bytes — comparing text rejects every
  // single-character alteration and every non-canonical encoding.
  const expected = Buffer.from(b64url(mac(key, `${REQUEST_STATE_PREFIX}.${kid}.${body}`)), 'utf8');
  const given = Buffer.from(sig, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw invalidRequestState('mac');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalidRequestState('schema');
  }
  if (!isPayload(parsed)) throw invalidRequestState('schema');
  return parsed;
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}
