/**
 * mail.* MCP tools — xiRAID email notification management.
 *
 * Manages notification recipients (address + severity level), polling
 * intervals, and test email delivery via xiRAID gRPC + xicli fallback.
 */

import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getClient, withRetry } from '../grpc/client.js';
import { mailShow, mailAdd, mailRemove } from '../grpc/mail.js';
import { settingsMailShow, settingsMailModify } from '../grpc/settings.js';
import { applyWithPlan } from '../middleware/planApply.js';
import { resolveController } from '../server/controllerResolver.js';
import type { PlanResult, Mode } from '../types/common.js';
import { McpToolError, ErrorCode } from '../types/common.js';

const execFileAsync = promisify(execFile);

const VALID_LEVELS = ['info', 'warning', 'error'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Schemas ---

export const MailListRecipientsSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
});

export const MailAddRecipientSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
  address: z.string().min(1).describe('Recipient email address'),
  level: z.enum(VALID_LEVELS).describe('Minimum notification level: info (all), warning (warn+error), error (errors only)'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const MailRemoveRecipientSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
  address: z.string().min(1).describe('Recipient email address to remove'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const MailGetSettingsSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
});

export const MailUpdateSettingsSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
  polling_interval: z.number().int().min(1).optional().describe('RAID/drive state polling interval in seconds'),
  progress_polling_interval: z.number().int().min(1).optional().describe('Init/reconstruction progress polling interval in minutes'),
  mode: z.enum(['plan', 'apply']).default('plan'),
});

export const MailSendTestSchema = z.object({
  controller_id: z.string().optional().describe('Controller UUID (defaults to local)'),
});

// --- Handlers ---

export async function handleMailListRecipients(
  params: z.infer<typeof MailListRecipientsSchema>,
): Promise<unknown> {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(() => mailShow(client), 'mail.list_recipients');
  return resp.data;
}

export async function handleMailAddRecipient(
  params: z.infer<typeof MailAddRecipientSchema>,
): Promise<PlanResult | unknown> {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  if (!EMAIL_RE.test(params.address)) {
    throw new McpToolError(ErrorCode.INVALID_ARGUMENT, `Invalid email address: ${params.address}`);
  }

  return applyWithPlan(mode, {
    preflight: async () => ({
      mode: 'plan' as const,
      description: `Add notification recipient ${params.address} at level '${params.level}'`,
      changes: [{
        action: 'create' as const,
        resource_type: 'mail_recipient',
        resource_id: params.address,
        after: { address: params.address, level: params.level },
      }],
      warnings: [],
      preflight_passed: true,
    }),

    execute: async () => {
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => mailAdd(client, { address: params.address, level: params.level }),
        'mail.add_recipient',
      );
      return resp.data ?? { address: params.address, level: params.level, status: 'added' };
    },
  });
}

export async function handleMailRemoveRecipient(
  params: z.infer<typeof MailRemoveRecipientSchema>,
): Promise<PlanResult | unknown> {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  return applyWithPlan(mode, {
    preflight: async () => {
      // Verify the recipient exists
      const client = await getClient(params.controller_id);
      const resp = await withRetry(() => mailShow(client), 'mail.remove_recipient preflight');
      const recipients = resp.data as Array<{ address?: string; email?: string }> | null;
      const found = recipients?.some(
        r => (r.address ?? r.email) === params.address,
      );

      const blockingResources: string[] = [];
      if (!found) {
        blockingResources.push(`Recipient '${params.address}' not found in notification list`);
      }

      return {
        mode: 'plan' as const,
        description: `Remove notification recipient ${params.address}`,
        changes: [{
          action: 'delete' as const,
          resource_type: 'mail_recipient',
          resource_id: params.address,
          before: { address: params.address },
        }],
        warnings: [],
        preflight_passed: blockingResources.length === 0,
        ...(blockingResources.length > 0 ? { blocking_resources: blockingResources } : {}),
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      const resp = await withRetry(
        () => mailRemove(client, { address: params.address }),
        'mail.remove_recipient',
      );
      return resp.data ?? { address: params.address, status: 'removed' };
    },
  });
}

export async function handleMailGetSettings(
  params: z.infer<typeof MailGetSettingsSchema>,
): Promise<unknown> {
  resolveController(params.controller_id);
  const client = await getClient(params.controller_id);
  const resp = await withRetry(() => settingsMailShow(client), 'mail.get_settings');
  return resp.data;
}

export async function handleMailUpdateSettings(
  params: z.infer<typeof MailUpdateSettingsSchema>,
): Promise<PlanResult | unknown> {
  resolveController(params.controller_id);
  const mode = params.mode as Mode;

  if (params.polling_interval == null && params.progress_polling_interval == null) {
    throw new McpToolError(
      ErrorCode.INVALID_ARGUMENT,
      'At least one of polling_interval or progress_polling_interval must be provided',
    );
  }

  return applyWithPlan(mode, {
    preflight: async () => {
      const client = await getClient(params.controller_id);
      const resp = await withRetry(() => settingsMailShow(client), 'mail.update_settings preflight');
      const current = resp.data as Record<string, unknown> | null;

      const changes: Array<{ action: 'modify'; resource_type: string; resource_id: string; before?: unknown; after?: unknown }> = [];
      if (params.polling_interval != null) {
        changes.push({
          action: 'modify',
          resource_type: 'mail_setting',
          resource_id: 'polling_interval',
          before: current?.polling_interval,
          after: params.polling_interval,
        });
      }
      if (params.progress_polling_interval != null) {
        changes.push({
          action: 'modify',
          resource_type: 'mail_setting',
          resource_id: 'progress_polling_interval',
          before: current?.progress_polling_interval,
          after: params.progress_polling_interval,
        });
      }

      return {
        mode: 'plan' as const,
        description: 'Update mail polling intervals',
        changes,
        warnings: [],
        preflight_passed: true,
      } satisfies PlanResult;
    },

    execute: async () => {
      const client = await getClient(params.controller_id);
      const req: { polling_interval?: number; progress_polling_interval?: number } = {};
      if (params.polling_interval != null) req.polling_interval = params.polling_interval;
      if (params.progress_polling_interval != null) req.progress_polling_interval = params.progress_polling_interval;

      const resp = await withRetry(
        () => settingsMailModify(client, req),
        'mail.update_settings',
      );
      return resp.data ?? { ...req, status: 'updated' };
    },
  });
}

export async function handleMailSendTest(
  params: z.infer<typeof MailSendTestSchema>,
): Promise<unknown> {
  resolveController(params.controller_id);

  try {
    const { stdout, stderr } = await execFileAsync('xicli', ['mail', 'send'], { timeout: 30_000 });
    return { status: 'sent', message: (stdout || stderr).trim() || 'Test notification sent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpToolError(ErrorCode.INTERNAL, `Failed to send test notification: ${msg}`);
  }
}
