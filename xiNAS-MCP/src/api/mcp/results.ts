/**
 * Tool-result shapes shared by the dispatcher, the modern handler and the
 * S15 confirmation service. Moved out of dispatch.ts so the confirmation
 * service can build results without importing the dispatcher (which imports
 * the service — types only, but keep the value graph acyclic).
 */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ElicitFormParams {
  mode: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, { type: 'string'; enum: string[]; title: string }>;
    required: string[];
  };
}

export interface ElicitUrlParams {
  mode: 'url';
  message: string;
  url: string;
}

export interface ElicitRequestSpec {
  method: 'elicitation/create';
  params: ElicitFormParams | ElicitUrlParams;
}

/** The unfinished-MRTR answer (S15 §4.3/§4.4): always both fields. */
export interface InputRequiredToolResult {
  resultType: 'input_required';
  inputRequests: Record<string, ElicitRequestSpec>;
  requestState: string;
}

export const text = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
});

export const errorResult = (code: string, message: string, details?: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
  isError: true,
});

export function isInputRequired(
  r: ToolResult | InputRequiredToolResult,
): r is InputRequiredToolResult {
  return (r as InputRequiredToolResult).resultType === 'input_required';
}
