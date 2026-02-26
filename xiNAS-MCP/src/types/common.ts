/**
 * Shared types used across all xiNAS-MCP layers.
 */

export const ErrorCode = {
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_FOUND: 'NOT_FOUND',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFLICT: 'CONFLICT',
  TIMEOUT: 'TIMEOUT',
  UNSUPPORTED: 'UNSUPPORTED',
  INTERNAL: 'INTERNAL',
  RESOURCE_EXHAUSTION: 'RESOURCE_EXHAUSTION',
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

export class McpToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export type Role = 'viewer' | 'operator' | 'admin';
export type Mode = 'plan' | 'apply';

export interface PlanChange {
  action: 'create' | 'modify' | 'delete' | 'no-op';
  resource_type: string;
  resource_id: string;
  before?: unknown;
  after?: unknown;
}

export interface PlanResult {
  mode: 'plan';
  description: string;
  changes: PlanChange[];
  warnings: string[];
  preflight_passed: boolean;
  blocking_resources?: string[];
}

export interface JobRecord {
  job_id: string;
  controller_id: string;
  tool_name: string;
  started_at: string;
  state: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  progress_pct?: number;
  result?: unknown;
  error?: string;
}

export interface CallContext {
  request_id: string;
  principal: string;
  role: Role;
  timestamp: string;
}

export interface ControllerInfo {
  controller_id: string;
  hostname: string;
  grpc_endpoint: string;
  nfs_socket: string;
}
