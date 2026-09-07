import { describe, expect, it } from 'vitest';
import {
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  validateTaskMethodHeaders,
} from '../../../api/mcp/tasks/headers.js';

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
const msg = (method: string, taskId: unknown = 'task-1') => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { _meta: META, taskId },
});
const hdr = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe('validateTaskMethodHeaders (S16 §5.6)', () => {
  it('accepts agreeing headers, with and without the protocol version', () => {
    expect(() =>
      validateTaskMethodHeaders(
        hdr({ 'mcp-method': 'tasks/get', 'mcp-name': 'task-1' }),
        msg('tasks/get'),
      ),
    ).not.toThrow();
    expect(() =>
      validateTaskMethodHeaders(
        hdr({
          'mcp-method': 'tasks/get',
          'mcp-name': 'task-1',
          'mcp-protocol-version': '2026-07-28',
        }),
        msg('tasks/get'),
      ),
    ).not.toThrow();
  });
  it('rejects a missing or mismatched Mcp-Method / Mcp-Name with -32020 and HTTP 400', () => {
    for (const h of [
      { 'mcp-name': 'task-1' },
      { 'mcp-method': 'tools/call', 'mcp-name': 'task-1' },
      { 'mcp-method': 'tasks/get' },
      { 'mcp-method': 'tasks/get', 'mcp-name': 'task-2' },
    ]) {
      expect(() => validateTaskMethodHeaders(hdr(h), msg('tasks/get'))).toThrow(
        expect.objectContaining({ code: -32020, httpStatus: 400 }),
      );
    }
  });
  it('rejects a protocol-version header that disagrees with _meta', () => {
    expect(() =>
      validateTaskMethodHeaders(
        hdr({
          'mcp-method': 'tasks/cancel',
          'mcp-name': 'task-1',
          'mcp-protocol-version': '2025-11-25',
        }),
        msg('tasks/cancel'),
      ),
    ).toThrow(expect.objectContaining({ code: -32020 }));
  });
  it('decodes the base64 sentinel before comparing', () => {
    const encoded = encodeMcpHeaderValue('täsk 1');
    expect(encoded.startsWith('=?base64?')).toBe(true);
    expect(decodeMcpHeaderValue(encoded)).toBe('täsk 1');
    expect(() =>
      validateTaskMethodHeaders(
        hdr({ 'mcp-method': 'tasks/get', 'mcp-name': encoded }),
        msg('tasks/get', 'täsk 1'),
      ),
    ).not.toThrow();
    expect(encodeMcpHeaderValue('plain')).toBe('plain');
    expect(encodeMcpHeaderValue('=?base64?x?=').startsWith('=?base64?')).toBe(true);
    expect(decodeMcpHeaderValue('=?base64?!!!?=')).toBeNull();
  });
  it('round-trips an empty value through the sentinel but still rejects non-empty invalid base64', () => {
    expect(decodeMcpHeaderValue(encodeMcpHeaderValue(''))).toBe('');
    expect(decodeMcpHeaderValue('=?base64?!!!?=')).toBeNull();
  });
  it('skips the name check when taskId is not a string (the handler answers -32602) and ignores non-task methods', () => {
    expect(() =>
      validateTaskMethodHeaders(hdr({ 'mcp-method': 'tasks/get' }), msg('tasks/get', 7)),
    ).not.toThrow();
    expect(() =>
      validateTaskMethodHeaders(hdr({}), {
        method: 'tools/call',
        params: { _meta: META, name: 'x' },
      }),
    ).not.toThrow();
  });
});
