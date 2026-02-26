/**
 * Job tracking manager and job.* MCP tools.
 * Long-running operations create a JobRecord tracked in-memory.
 */

import { v4 as uuidv4 } from 'uuid';
import type { JobRecord } from '../types/common.js';
import { McpToolError, ErrorCode } from '../types/common.js';
import { z } from 'zod';

// In-memory job store
const jobs = new Map<string, JobRecord>();

export class JobManager {
  static create(controllerId: string, toolName: string): JobRecord {
    const record: JobRecord = {
      job_id: uuidv4(),
      controller_id: controllerId,
      tool_name: toolName,
      started_at: new Date().toISOString(),
      state: 'queued',
    };
    jobs.set(record.job_id, record);
    return record;
  }

  static update(jobId: string, patch: Partial<JobRecord>): void {
    const record = jobs.get(jobId);
    if (record) {
      Object.assign(record, patch);
    }
  }

  static get(jobId: string): JobRecord {
    const record = jobs.get(jobId);
    if (!record) throw new McpToolError(ErrorCode.NOT_FOUND, `Job not found: ${jobId}`);
    return record;
  }

  static list(controllerId: string): JobRecord[] {
    return Array.from(jobs.values()).filter(j => j.controller_id === controllerId);
  }

  static cancel(jobId: string): void {
    const record = jobs.get(jobId);
    if (!record) throw new McpToolError(ErrorCode.NOT_FOUND, `Job not found: ${jobId}`);
    if (record.state === 'success' || record.state === 'failed') {
      throw new McpToolError(ErrorCode.PRECONDITION_FAILED, `Job ${jobId} is already ${record.state}`);
    }
    record.state = 'cancelled';
  }
}

// --- Zod schemas ---

export const JobGetSchema = z.object({
  job_id: z.string().describe('Job ID returned by a long-running operation'),
});

export const JobListSchema = z.object({
  controller_id: z.string().describe('Controller UUID'),
});

export const JobCancelSchema = z.object({
  job_id: z.string().describe('Job ID to cancel'),
});

// --- Tool handlers ---

export function handleJobGet(params: z.infer<typeof JobGetSchema>): JobRecord {
  return JobManager.get(params.job_id);
}

export function handleJobList(params: z.infer<typeof JobListSchema>): JobRecord[] {
  return JobManager.list(params.controller_id);
}

export function handleJobCancel(params: z.infer<typeof JobCancelSchema>): { cancelled: true; job_id: string } {
  JobManager.cancel(params.job_id);
  return { cancelled: true, job_id: params.job_id };
}
