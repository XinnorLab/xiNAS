/**
 * Pure formatting for the S18 RAID Create View's plan panel (spec §7.1).
 *
 * Kept free of DOM and host-bridge imports so the unit suite can exercise it;
 * `raid-create.ts` owns the rendering and escapes whatever this returns.
 */

/** One entry of a plan's `affected_resources` (api-v1 `ResourceRef`). */
export interface AffectedResource {
  kind?: string;
  id?: string;
}

/**
 * Same shape as the S15 confirmation message renders — `kind id`, joined by
 * `; ` — so the operator reads one list in the App and in the MRTR prompt.
 */
export function affectedResourcesText(items: AffectedResource[] | undefined): string {
  if (items === undefined || items.length === 0) return '(none listed)';
  return items
    .map((item) => [item.kind, item.id].filter((part) => part !== undefined).join(' '))
    .join('; ');
}

export interface HandoffArguments {
  mode: 'apply';
  plan_id: string;
  expected_revision: number;
  idempotency_key: string;
}

/** The exact apply arguments the host must send (S18 §7.2). */
export function handoffArguments(
  plan: { plan_id: string; state_revision_expected?: number },
  idempotencyKey: string,
): HandoffArguments {
  return {
    mode: 'apply',
    plan_id: plan.plan_id,
    expected_revision: plan.state_revision_expected ?? 0,
    idempotency_key: idempotencyKey,
  };
}

/**
 * The user message handed to the host (S18 §7.2, §8). The host executes the
 * apply and gets ONE of two results, decided by the capabilities on its
 * final confirmation retry (S16 §8); it must continue by the one it got.
 */
export function handoffMessage(
  tools: { create: string; task_wait: string },
  args: HandoffArguments,
): string {
  return [
    'I reviewed the xiNAS RAID creation plan in the MCP App and request secure execution.',
    `Call ${tools.create} with exactly these arguments:`,
    JSON.stringify(args, null, 2),
    'Continue through the existing MRTR confirmation flow. Do not bypass confirmation and do not re-plan unless the server reports that this plan is stale.',
    'Then follow the result you actually receive:',
    '- resultType "task": keep its taskId (it is the xiNAS task_id), poll tasks/get at the returned pollIntervalMs until the status is terminal, and read the final CallToolResult — isError: true means the array was NOT created even though the task reads "completed".',
    `- resultType "complete": the result carries task_id and a next hint; call ${tools.task_wait} with that id until the task state is terminal (success, failed, cancelled, requires_manual_recovery).`,
    'A terminal task reports the control-path operation only: xiRAID initialization continues in the background and is reported separately (arrays.get, or the raid and raid/progress event feeds).',
  ].join('\n\n');
}
