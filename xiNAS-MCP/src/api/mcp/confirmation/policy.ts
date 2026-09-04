import { createHash } from 'node:crypto';
import { canonicalize } from '../../../lib/canonical-json.js';
import type { CatalogEntry } from '../catalog.js';
import { INVALID_PARAMS, McpProtocolError } from './errors.js';
import { REQUEST_STATE_MAX_BYTES } from './state.js';
import type { ConfirmationMode } from './types.js';

export type ElicitationMode = 'form' | 'url';

const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

/** S15 §3.2 — decided from the persisted plan document only. */
export function confirmationModeFor(riskLevel: string, rollbackModel: string): ConfirmationMode {
  if (rollbackModel === 'unsupported') return 'url';
  return riskLevel === 'destructive' || riskLevel === 'unsupported_rollback' ? 'url' : 'form';
}

/** sha256 over canonical `{ name, arguments }` — key order irrelevant, any value change visible. */
export function argumentsHash(name: string, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalize({ name, arguments: args }), 'utf8')
    .digest('hex');
}

/**
 * Elicitation modes the CURRENT request declares (S15 §14.1). The vendor
 * rule: an empty `elicitation: {}` means form-only; absent means none.
 */
export function elicitationModes(meta: unknown): Set<ElicitationMode> {
  const out = new Set<ElicitationMode>();
  if (meta === null || typeof meta !== 'object') return out;
  const caps = (meta as Record<string, unknown>)[CLIENT_CAPABILITIES_META];
  if (caps === null || typeof caps !== 'object') return out;
  const elicitation = (caps as Record<string, unknown>).elicitation;
  if (elicitation === null || typeof elicitation !== 'object') return out;
  const e = elicitation as Record<string, unknown>;
  if (e.form !== undefined) out.add('form');
  if (e.url !== undefined) out.add('url');
  if (out.size === 0) out.add('form'); // backwards-compatibility rule
  return out;
}

/** S15 §3.1 — which calls the confirmation service must see. */
export function isConfirmable(entry: CatalogEntry, args: Record<string, unknown>): boolean {
  if (entry.confirmation === 'required') return true;
  if (entry.mutability === 'plan_apply') return args.mode === 'apply';
  if (entry.mutability === 'direct') return entry.requires_mcp_apply === true;
  return false;
}

export interface ElicitResultLike {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

export interface MrtrParams {
  inputResponses?: Record<string, ElicitResultLike>;
  requestState?: string;
}

const isPrimitive = (v: unknown): boolean =>
  typeof v === 'string' ||
  typeof v === 'number' ||
  typeof v === 'boolean' ||
  (Array.isArray(v) && v.every((x) => typeof x === 'string'));

function isElicitResult(v: unknown): v is ElicitResultLike {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.action !== 'accept' && r.action !== 'decline' && r.action !== 'cancel') return false;
  if (r.content === undefined) return true;
  if (r.content === null || typeof r.content !== 'object' || Array.isArray(r.content)) return false;
  return Object.values(r.content as Record<string, unknown>).every(isPrimitive);
}

/** S14 §5.1 retry parsing: malformed → JSON-RPC -32602 (HTTP 200). */
export function parseMrtrParams(params: unknown): MrtrParams {
  const p = (params ?? {}) as Record<string, unknown>;
  const out: MrtrParams = {};
  if (p.inputResponses !== undefined) {
    const ir = p.inputResponses;
    if (
      ir === null ||
      typeof ir !== 'object' ||
      Array.isArray(ir) ||
      !Object.values(ir as object).every(isElicitResult)
    ) {
      throw new McpProtocolError(INVALID_PARAMS, 'invalid params: inputResponses');
    }
    out.inputResponses = ir as Record<string, ElicitResultLike>;
  }
  if (p.requestState !== undefined) {
    if (
      typeof p.requestState !== 'string' ||
      Buffer.byteLength(p.requestState, 'utf8') > REQUEST_STATE_MAX_BYTES
    ) {
      throw new McpProtocolError(INVALID_PARAMS, 'invalid params: requestState');
    }
    out.requestState = p.requestState;
  }
  return out;
}
