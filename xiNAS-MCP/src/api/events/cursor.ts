/**
 * Opaque feed cursors (S17 §7.4, decision D-21).
 *
 *   cursor = base64url( "1" SEP controllerId SEP feed SEP decimal(S) SEP tag )
 *   tag    = first 8 bytes of SHA-256 over the four fields, base64url
 *
 * The cursor is versioned and scoped (controller generation + feed) so a
 * value issued elsewhere is refused rather than silently replaying another
 * feed's rows; the tag only detects tampering or corruption — it is not a
 * secret and a cursor is not an authorization capability (spec §9.4).
 * Every failure is the one fixed message so nothing about the journal or
 * the scope leaks through the error.
 */

import { createHash } from 'node:crypto';
import type { Feed } from './types.js';

const SEP = '\x1f';
const VERSION = '1';
const MAX_LEN = 256;
/** 8 bytes of SHA-256 → 11 base64url characters (no padding). */
const TAG_CHARS = 11;

export class CursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'CursorError';
  }
}

function tag(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, TAG_CHARS);
}

export function encodeCursor(p: { controllerId: string; feed: Feed; sequence: number }): string {
  const body = [VERSION, p.controllerId, p.feed, String(p.sequence)].join(SEP);
  return Buffer.from(`${body}${SEP}${tag(body)}`, 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string,
  scope: { controllerId: string; feed: Feed; last: number },
): { sequence: number } {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_LEN ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new CursorError();
  }
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = text.split(SEP);
  if (parts.length !== 5) throw new CursorError();
  const [version, controllerId, feed, seqText, t] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== VERSION || controllerId !== scope.controllerId || feed !== scope.feed) {
    throw new CursorError();
  }
  if (!/^(0|[1-9][0-9]{0,15})$/.test(seqText)) throw new CursorError();
  const sequence = Number(seqText);
  if (!Number.isSafeInteger(sequence) || sequence > scope.last) throw new CursorError();
  if (tag([version, controllerId, feed, seqText].join(SEP)) !== t) throw new CursorError();
  return { sequence };
}
