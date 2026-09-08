import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  classifyWarnings,
  type InventoryTrust,
  type InventoryWarning,
  inventoryBanner,
  isPooled,
  pooledDevicePaths,
  warningText,
} from './inventory-facts.js';
import {
  type AffectedResource,
  affectedResourcesText,
  handoffArguments,
  handoffMessage,
} from './plan-facts.js';
import './raid-create.css';

type RaidLevel =
  | 'raid0'
  | 'raid1'
  | 'raid5'
  | 'raid6'
  | 'raid7'
  | 'raid10'
  | 'raid50'
  | 'raid60'
  | 'raid70'
  | 'n+m';

interface LevelConstraint {
  min_drives: number;
  even_members: boolean;
  needs_group_size: boolean;
  group_size_min: number;
  group_size_max: number;
  needs_synd_cnt: boolean;
  synd_cnt_min: number;
  synd_cnt_max: number;
}

interface AppConfig {
  app: 'raid_create';
  resource_uri: string;
  levels: RaidLevel[];
  constraints: Record<RaidLevel, LevelConstraint>;
  strip_sizes_kib: number[];
  block_sizes: number[];
  defaults: { level: RaidLevel; strip_size_kib: number; block_size: number };
  tools: {
    disks: string;
    arrays: string;
    pools: string;
    create: string;
    task_wait: string;
  };
}

interface Disk {
  id: string;
  status?: {
    device_path?: string;
    serial?: string;
    model?: string;
    capacity_bytes?: number;
    numa_node?: number;
    system_disk?: boolean;
    mounted?: boolean;
    safe_for_use?: boolean;
    xiraid_membership?: { array_id?: string; role?: string } | null;
    health?: { ok?: boolean; wear_pct?: number; temperature_c?: number };
  };
}

interface Pool {
  name?: string;
  drives?: string[];
  active?: boolean;
  referenced_by?: string[];
}

interface ArrayRow {
  id?: string;
  spec?: { name?: string; member_disk_ids?: string[] };
}

interface PlanIssue {
  code?: string;
  message?: string;
}

interface Plan {
  plan_id: string;
  state_revision_expected?: number;
  risk_level?: string;
  rollback_model?: string;
  affected_resources?: AffectedResource[];
  blockers?: PlanIssue[];
  warnings?: PlanIssue[];
  diff?: unknown;
}

interface Envelope<T> {
  result: T;
  warnings?: PlanIssue[];
}

const app = new App({ name: 'xiNAS RAID Create', version: '1.0.0' });
const rootElement = document.querySelector<HTMLElement>('#app');
if (rootElement === null) throw new Error('missing #app root');
const root: HTMLElement = rootElement;

let config: AppConfig | null = null;
let disks: Disk[] = [];
let pools: Pool[] = [];
let arrays: ArrayRow[] = [];
let selected = new Set<string>();
let plan: Plan | null = null;
let planFingerprint = '';
let busy = false;
let statusMessage = 'Connecting to xiNAS…';
let statusKind: 'info' | 'success' | 'error' = 'info';
let handoffSent = false;
let inventoryTrust: InventoryTrust = 'none';
let inventoryDetail = '';
let inventoryAdvisories: InventoryWarning[] = [];

function textContent(result: CallToolResult): string {
  const block = result.content?.find((item) => item.type === 'text');
  if (block?.type !== 'text') throw new Error('xiNAS returned no text result');
  return block.text;
}

function parseResult<T>(result: CallToolResult): T {
  let payload: unknown;
  try {
    payload = JSON.parse(textContent(result));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('xiNAS returned malformed tool data');
    throw error;
  }
  if (result.isError) {
    const detail = payload as { error?: { message?: string; code?: string } };
    throw new Error(detail.error?.message ?? detail.error?.code ?? 'xiNAS tool call failed');
  }
  return payload as T;
}

async function callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  return parseResult<T>(result);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'Capacity unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}

function unavailableReason(
  disk: Disk,
  pooled: Set<string> = pooledDevicePaths(pools),
): string | null {
  const status = disk.status ?? {};
  if (status.system_disk === true) return 'System disk';
  if (status.mounted === true) return 'Mounted';
  if (status.xiraid_membership != null) {
    return `Member of ${status.xiraid_membership.array_id ?? 'an array'}`;
  }
  if (status.device_path?.startsWith('/dev/xi_')) return 'xiRAID volume, not a physical disk';
  if (isPooled(disk, pooled)) return 'Assigned to a spare pool';
  if (status.safe_for_use !== true) return 'Not marked safe for use';
  return null;
}

function selectedDisks(): Disk[] {
  return disks.filter((disk) => selected.has(disk.id));
}

function fieldValue(id: string): string {
  return (
    document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value ?? ''
  ).trim();
}

function currentLevel(): RaidLevel {
  return (fieldValue('raid-level') || config?.defaults.level || 'raid6') as RaidLevel;
}

function currentSpec(): Record<string, unknown> {
  const level = currentLevel();
  const constraint = config?.constraints[level];
  const sparePool = fieldValue('spare-pool');
  return {
    name: fieldValue('array-name'),
    level,
    member_disk_ids: [...selected],
    strip_size_kib: Number(fieldValue('strip-size')),
    block_size: Number(fieldValue('block-size')),
    ...(constraint?.needs_group_size ? { group_size: Number(fieldValue('group-size')) } : {}),
    ...(constraint?.needs_synd_cnt ? { synd_cnt: Number(fieldValue('synd-count')) } : {}),
    ...(sparePool.length > 0 ? { spare_pool: sparePool } : {}),
  };
}

function fingerprint(): string {
  const spec = currentSpec();
  const ids = [...(spec.member_disk_ids as string[])].sort();
  return JSON.stringify({ ...spec, member_disk_ids: ids });
}

function validationErrors(): string[] {
  if (config === null) return ['Configuration is not loaded'];
  const errors: string[] = [];
  if (inventoryTrust !== 'trusted') {
    errors.push('Inventory is not current — refresh before planning.');
  }
  const name = fieldValue('array-name');
  if (!/^[A-Za-z0-9_]{1,28}$/.test(name)) {
    errors.push('Name must use 1–28 Latin letters, digits, or underscores.');
  } else if (name === 'power' || name === 'uevent') {
    errors.push(`“${name}” is reserved by xiRAID.`);
  } else if (arrays.some((row) => (row.spec?.name ?? row.id) === name)) {
    errors.push(`An array named “${name}” already exists.`);
  }

  const level = currentLevel();
  const rule = config.constraints[level];
  const count = selected.size;
  if (count < rule.min_drives) {
    errors.push(`${level.toUpperCase()} needs at least ${rule.min_drives} member disks.`);
  }
  if (rule.even_members && count % 2 !== 0) {
    errors.push(`${level.toUpperCase()} needs an even number of member disks.`);
  }
  if (rule.needs_group_size) {
    const group = Number(fieldValue('group-size'));
    if (!Number.isInteger(group) || group < rule.group_size_min || group > rule.group_size_max) {
      errors.push(`Group size must be ${rule.group_size_min}–${rule.group_size_max}.`);
    } else if (count % group !== 0 || count / group < 2) {
      errors.push(`${count} disks do not split into at least two groups of ${group}.`);
    }
  }
  if (rule.needs_synd_cnt) {
    const synd = Number(fieldValue('synd-count'));
    if (!Number.isInteger(synd) || synd < rule.synd_cnt_min || synd > rule.synd_cnt_max) {
      errors.push(`Syndrome count must be ${rule.synd_cnt_min}–${rule.synd_cnt_max}.`);
    }
  }
  return errors;
}

function capacityEstimate(): number | null {
  const chosen = selectedDisks();
  const capacities = chosen
    .map((disk) => disk.status?.capacity_bytes)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  if (capacities.length !== chosen.length || chosen.length === 0) return null;
  const count = chosen.length;
  const level = currentLevel();
  let dataMembers = 0;
  if (level === 'raid0') dataMembers = count;
  if (level === 'raid1') dataMembers = 1;
  if (level === 'raid5') dataMembers = count - 1;
  if (level === 'raid6') dataMembers = count - 2;
  if (level === 'raid7') dataMembers = count - 3;
  if (level === 'raid10') dataMembers = count / 2;
  if (level === 'raid50' || level === 'raid60' || level === 'raid70') {
    const groupSize = Number(fieldValue('group-size'));
    const parity = level === 'raid50' ? 1 : level === 'raid60' ? 2 : 3;
    dataMembers = count - (count / groupSize) * parity;
  }
  if (level === 'n+m') dataMembers = count - Number(fieldValue('synd-count'));
  if (!Number.isFinite(dataMembers) || dataMembers <= 0) return null;
  return Math.min(...capacities) * dataMembers;
}

function option(value: string | number, selectedValue: string | number): string {
  return `<option value="${escapeHtml(value)}" ${String(value) === String(selectedValue) ? 'selected' : ''}>${escapeHtml(value)}</option>`;
}

function diskCards(): string {
  if (disks.length === 0) return '<div class="empty">No disks were reported by xiNAS.</div>';
  const pooled = pooledDevicePaths(pools);
  return disks
    .slice()
    .sort((a, b) => (a.status?.device_path ?? a.id).localeCompare(b.status?.device_path ?? b.id))
    .map((disk) => {
      const reason = unavailableReason(disk, pooled);
      const checked = selected.has(disk.id);
      const health = disk.status?.health;
      const healthLabel =
        health?.ok === false ? 'Attention' : health?.ok === true ? 'Healthy' : 'Unknown';
      return `<label class="disk-card ${reason !== null ? 'disabled' : ''} ${checked ? 'selected' : ''}">
        <input type="checkbox" data-disk-id="${escapeHtml(disk.id)}" ${checked ? 'checked' : ''} ${reason !== null ? 'disabled' : ''} />
        <span class="disk-check" aria-hidden="true">${checked ? '✓' : ''}</span>
        <span class="disk-main">
          <span class="disk-path">${escapeHtml(disk.status?.device_path ?? disk.id)}</span>
          <span class="disk-model">${escapeHtml(disk.status?.model ?? 'Unknown model')} · ${escapeHtml(disk.status?.serial ?? 'No serial')}</span>
          <span class="disk-meta">
            <span>${escapeHtml(formatBytes(disk.status?.capacity_bytes))}</span>
            <span>NUMA ${escapeHtml(disk.status?.numa_node ?? '—')}</span>
            <span class="health ${health?.ok === false ? 'bad' : ''}">${healthLabel}</span>
          </span>
          ${reason !== null ? `<span class="disk-reason">${escapeHtml(reason)}</span>` : ''}
        </span>
      </label>`;
    })
    .join('');
}

function issueList(issues: PlanIssue[] | undefined, empty: string): string {
  if (!issues || issues.length === 0) return `<p class="quiet">${empty}</p>`;
  return `<ul class="issues">${issues
    .map(
      (issue) =>
        `<li><code>${escapeHtml(issue.code ?? 'notice')}</code><span>${escapeHtml(issue.message ?? '')}</span></li>`,
    )
    .join('')}</ul>`;
}

function planPanel(): string {
  if (plan === null) {
    return `<section class="panel review-placeholder">
      <div class="placeholder-mark">03</div>
      <h2>Review the authoritative plan</h2>
      <p>xiNAS will validate current disk state, topology, leases, and the exact xiRAID request before any change is allowed.</p>
    </section>`;
  }
  const blocked = (plan.blockers?.length ?? 0) > 0 || inventoryTrust !== 'trusted';
  const stale = planFingerprint !== fingerprint();
  // `.plan-facts dd` ellipsises; the title carries the full list on hover.
  const affected = escapeHtml(affectedResourcesText(plan.affected_resources));
  return `<section class="panel review-panel">
    <div class="section-head">
      <div><span class="eyebrow">03 · REVIEW</span><h2>Server plan</h2></div>
      <span class="plan-state ${blocked || stale ? 'blocked' : 'ready'}">${stale ? 'STALE' : blocked ? 'BLOCKED' : 'READY'}</span>
    </div>
    <dl class="plan-facts">
      <div><dt>Plan ID</dt><dd class="mono">${escapeHtml(plan.plan_id)}</dd></div>
      <div><dt>Risk</dt><dd>${escapeHtml(plan.risk_level ?? '—')}</dd></div>
      <div><dt>Rollback</dt><dd>${escapeHtml(plan.rollback_model ?? '—')}</dd></div>
      <div><dt>Revision</dt><dd>${escapeHtml(plan.state_revision_expected ?? 0)}</dd></div>
      <div><dt>Affected</dt><dd title="${affected}">${affected}</dd></div>
    </dl>
    ${stale ? '<div class="notice warning">Configuration changed after planning. Review a new plan.</div>' : ''}
    <div class="review-grid">
      <div><h3>Blockers</h3>${issueList(plan.blockers, 'No blockers reported.')}</div>
      <div><h3>Warnings</h3>${issueList(plan.warnings, 'No warnings reported.')}</div>
    </div>
    <details><summary>Exact server diff</summary><pre>${escapeHtml(JSON.stringify(plan.diff ?? {}, null, 2))}</pre></details>
    <button id="handoff-button" class="primary full" ${blocked || stale || busy || handoffSent ? 'disabled' : ''}>
      ${handoffSent ? 'Secure creation requested' : 'Request secure creation'}
    </button>
    <p class="security-note">The host will execute the existing apply tool and show the MRTR confirmation. This App cannot approve itself.</p>
  </section>`;
}

interface FocusState {
  selector: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  direction: 'forward' | 'backward' | 'none';
}

/** What the operator was doing before the DOM is replaced (S18 §6.1, §9). */
function captureFocus(): FocusState | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  let selector: string | null = null;
  if (active.id.length > 0) selector = `#${active.id}`;
  else if (active instanceof HTMLInputElement && active.dataset.diskId !== undefined) {
    selector = `input[data-disk-id="${active.dataset.diskId.replaceAll('"', '\\"')}"]`;
  }
  if (selector === null) return null;
  const text = active instanceof HTMLInputElement && active.type === 'text';
  return {
    selector,
    selectionStart: text ? active.selectionStart : null,
    selectionEnd: text ? active.selectionEnd : null,
    direction: text ? (active.selectionDirection ?? 'none') : 'none',
  };
}

function restoreFocus(state: FocusState | null): void {
  if (state === null) return;
  const el = root.querySelector<HTMLElement>(state.selector);
  if (el === null) return;
  el.focus({ preventScroll: true });
  if (
    el instanceof HTMLInputElement &&
    state.selectionStart !== null &&
    state.selectionEnd !== null
  ) {
    el.setSelectionRange(state.selectionStart, state.selectionEnd, state.direction);
  }
}

function render(): void {
  if (config === null) {
    root.innerHTML = `<div class="loading-shell"><div class="spinner"></div><h1>xiNAS RAID Create</h1><p>${escapeHtml(statusMessage)}</p></div>`;
    return;
  }
  const focus = captureFocus();
  const level = currentLevel();
  const rule = config.constraints[level];
  const errors = validationErrors();
  const estimate = capacityEstimate();
  const pooled = pooledDevicePaths(pools);
  const availableCount = disks.filter((disk) => unavailableReason(disk, pooled) === null).length;
  const existingName = fieldValue('array-name');
  const existingStrip = fieldValue('strip-size') || String(config.defaults.strip_size_kib);
  const existingBlock = fieldValue('block-size') || String(config.defaults.block_size);
  const existingPool = fieldValue('spare-pool');
  const existingGroup = fieldValue('group-size') || String(rule.group_size_min);
  const existingSynd = fieldValue('synd-count') || String(rule.synd_cnt_min);

  const banner = inventoryBanner(inventoryTrust, inventoryDetail);
  root.innerHTML = `<div class="app-shell" data-inventory-trust="${inventoryTrust}">
    <header class="hero">
      <div class="brand"><span class="brand-mark">xi</span><span>NAS</span></div>
      <div class="hero-copy"><span class="eyebrow">MCP APP · STORAGE CONTROL</span><h1>Create a xiRAID array</h1><p>Configure topology, select physical disks, and pass an authoritative plan to secure confirmation.</p></div>
      <div class="hero-stat"><strong>${selected.size}</strong><span>of ${availableCount} available<br />disks selected</span></div>
    </header>

    <div class="step-line"><span class="active">01 Configure</span><span class="active">02 Select drives</span><span class="${plan ? 'active' : ''}">03 Review & confirm</span></div>
    ${banner ? `<div class="notice error" id="inventory-banner" role="alert">${escapeHtml(banner)}</div>` : ''}
    ${inventoryAdvisories.length > 0 ? `<div class="notice warning" id="inventory-advisories">${inventoryAdvisories.map((w) => escapeHtml(warningText(w))).join('<br />')}</div>` : ''}

    <div class="workspace">
      <div class="form-column">
        <section class="panel">
          <div class="section-head"><div><span class="eyebrow">01 · CONFIGURE</span><h2>Array geometry</h2></div><span class="pill">Plan first</span></div>
          <div class="form-grid">
            <label class="field wide"><span>Array name</span><input id="array-name" type="text" value="${escapeHtml(existingName)}" maxlength="28" placeholder="e.g. data_01" autocomplete="off" /><small>1–28 letters, digits, underscore</small></label>
            <label class="field"><span>RAID level</span><select id="raid-level">${config.levels.map((value) => option(value, level)).join('')}</select><small>Minimum ${rule.min_drives} disks</small></label>
            <label class="field"><span>Strip size</span><select id="strip-size">${config.strip_sizes_kib.map((value) => option(value, existingStrip)).join('')}</select><small>KiB per member strip</small></label>
            <label class="field"><span>Block size</span><select id="block-size">${config.block_sizes.map((value) => option(value, existingBlock)).join('')}</select><small>Bytes</small></label>
            ${
              rule.needs_group_size
                ? `<label class="field"><span>Group size</span><select id="group-size">${Array.from(
                    { length: rule.group_size_max - rule.group_size_min + 1 },
                    (_, index) => index + rule.group_size_min,
                  )
                    .map((value) => option(value, existingGroup))
                    .join('')}</select><small>Members per RAID group</small></label>`
                : ''
            }
            ${
              rule.needs_synd_cnt
                ? `<label class="field"><span>Syndrome count (M)</span><select id="synd-count">${Array.from(
                    { length: rule.synd_cnt_max - rule.synd_cnt_min + 1 },
                    (_, index) => index + rule.synd_cnt_min,
                  )
                    .map((value) => option(value, existingSynd))
                    .join('')}</select><small>Parity/syndrome members</small></label>`
                : ''
            }
            <label class="field wide"><span>Existing spare pool <em>optional</em></span><select id="spare-pool"><option value="">No spare pool</option>${pools.map((pool) => option(pool.name ?? '', existingPool)).join('')}</select><small>The App does not create or modify spare pools.</small></label>
          </div>
          <div class="summary-strip">
            <div><span>Selected</span><strong>${selected.size} disks</strong></div>
            <div><span>Estimated usable</span><strong>${estimate === null ? '—' : formatBytes(estimate)}</strong></div>
            <div><span>Volume path</span><strong class="mono">${existingName ? `/dev/xi_${escapeHtml(existingName)}` : '—'}</strong></div>
          </div>
          <p class="estimate-note">Capacity is a geometry estimate based on the smallest selected drive. The server plan and observed result are authoritative.</p>
        </section>

        <section class="panel">
          <div class="section-head"><div><span class="eyebrow">02 · SELECT DRIVES</span><h2>Physical members</h2></div><button id="refresh-button" class="secondary" ${busy ? 'disabled' : ''}>Refresh</button></div>
          <div class="disk-toolbar"><span>${disks.length} observed</span><span>${availableCount} available</span><span>${pools.length} spare pools</span></div>
          <div class="disk-grid">${diskCards()}</div>
          <div class="validation ${errors.length === 0 ? 'valid' : ''}">
            <strong>${errors.length === 0 ? 'Configuration is ready for server validation.' : `${errors.length} item${errors.length === 1 ? '' : 's'} to resolve`}</strong>
            ${errors.length > 0 ? `<ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}
          </div>
          <button id="plan-button" class="primary full" ${errors.length > 0 || busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Review plan'}</button>
        </section>
      </div>
      <aside>${planPanel()}</aside>
    </div>
    <div class="toast ${statusKind}" role="status">${escapeHtml(statusMessage)}</div>
  </div>`;

  bindEvents();
  restoreFocus(focus);
}

function invalidatePlan(): void {
  handoffSent = false;
  render();
}

function bindEvents(): void {
  for (const id of [
    'array-name',
    'raid-level',
    'strip-size',
    'block-size',
    'group-size',
    'synd-count',
    'spare-pool',
  ]) {
    const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    element?.addEventListener(id === 'array-name' ? 'input' : 'change', invalidatePlan);
  }
  for (const checkbox of document.querySelectorAll<HTMLInputElement>('input[data-disk-id]')) {
    checkbox.addEventListener('change', () => {
      const id = checkbox.dataset.diskId;
      if (id === undefined) return;
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
      invalidatePlan();
    });
  }
  document
    .querySelector('#refresh-button')
    ?.addEventListener('click', () => void refreshInventory());
  document.querySelector('#plan-button')?.addEventListener('click', () => void requestPlan());
  document
    .querySelector('#handoff-button')
    ?.addEventListener('click', () => void requestSecureApply());
}

async function loadConfig(): Promise<void> {
  const payload = await callTool<Envelope<AppConfig>>('mcp_apps.raid_create');
  config = payload.result;
}

async function refreshInventory(): Promise<void> {
  if (config === null) return;
  busy = true;
  statusMessage = 'Refreshing observed storage inventory…';
  statusKind = 'info';
  render();
  try {
    const [diskPayload, arrayPayload, poolPayload] = await Promise.all([
      callTool<Envelope<Disk[]>>(config.tools.disks),
      callTool<Envelope<ArrayRow[]>>(config.tools.arrays),
      callTool<Envelope<Pool[]>>(config.tools.pools),
    ]);
    disks = diskPayload.result;
    arrays = arrayPayload.result;
    pools = poolPayload.result;
    const pooled = pooledDevicePaths(pools);
    selected = new Set(
      [...selected].filter((id) => {
        const disk = disks.find((candidate) => candidate.id === id);
        return disk !== undefined && unavailableReason(disk, pooled) === null;
      }),
    );
    plan = null;
    planFingerprint = '';
    handoffSent = false;
    const all = classifyWarnings([
      ...(diskPayload.warnings ?? []),
      ...(arrayPayload.warnings ?? []),
      ...(poolPayload.warnings ?? []),
    ]);
    inventoryAdvisories = all.advisory;
    if (all.blocking.length > 0) {
      inventoryTrust = 'degraded';
      inventoryDetail = all.blocking.map(warningText).join('; ');
      statusMessage = `Inventory refreshed with warnings · ${disks.length} disks observed`;
      statusKind = 'error';
    } else {
      inventoryTrust = 'trusted';
      inventoryDetail = '';
      statusMessage = `Inventory refreshed · ${disks.length} disks observed`;
      statusKind = 'success';
    }
  } catch (error) {
    statusMessage = error instanceof Error ? error.message : String(error);
    statusKind = 'error';
    inventoryTrust = 'failed';
    inventoryDetail = statusMessage;
    plan = null;
    planFingerprint = '';
    handoffSent = false;
  } finally {
    busy = false;
    render();
  }
}

async function requestPlan(): Promise<void> {
  if (config === null || validationErrors().length > 0 || inventoryTrust !== 'trusted') return;
  busy = true;
  statusMessage = 'xiNAS is validating the plan…';
  statusKind = 'info';
  render();
  try {
    const reviewedFingerprint = fingerprint();
    const payload = await callTool<Envelope<Plan>>(config.tools.create, {
      mode: 'plan',
      spec: currentSpec(),
    });
    if (typeof payload.result?.plan_id !== 'string')
      throw new Error('Plan response has no plan_id');
    plan = payload.result;
    planFingerprint = reviewedFingerprint;
    handoffSent = false;
    statusMessage =
      (plan.blockers?.length ?? 0) > 0 ? 'Plan returned with blockers' : 'Plan is ready for review';
    statusKind = (plan.blockers?.length ?? 0) > 0 ? 'error' : 'success';
  } catch (error) {
    plan = null;
    planFingerprint = '';
    statusMessage = error instanceof Error ? error.message : String(error);
    statusKind = 'error';
  } finally {
    busy = false;
    render();
  }
}

async function requestSecureApply(): Promise<void> {
  if (config === null || plan === null || planFingerprint !== fingerprint()) return;
  if (inventoryTrust !== 'trusted') return;
  if ((plan.blockers?.length ?? 0) > 0) return;
  busy = true;
  statusMessage = 'Passing the reviewed plan to the secure host workflow…';
  statusKind = 'info';
  render();
  const applyArguments = handoffArguments(plan, crypto.randomUUID());
  const message = handoffMessage(config.tools, applyArguments);
  try {
    const response = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: message }],
    });
    if (response.isError) throw new Error('The host declined the secure apply request');
    handoffSent = true;
    statusMessage = 'Secure creation requested · complete confirmation in the host';
    statusKind = 'success';
  } catch (error) {
    statusMessage = `${error instanceof Error ? error.message : String(error)}. The plan remains valid and can be applied from the conversation.`;
    statusKind = 'error';
  } finally {
    busy = false;
    render();
  }
}

app.ontoolresult = (result) => {
  if (config !== null) return;
  try {
    const payload = parseResult<Envelope<AppConfig>>(result);
    if (payload.result?.app === 'raid_create') config = payload.result;
  } catch {
    // The explicit load after connect owns error reporting.
  }
};

render();
void app
  .connect()
  .then(async () => {
    if (config === null) await loadConfig();
    statusMessage = 'Connected · loading observed inventory';
    render();
    await refreshInventory();
  })
  .catch((error: unknown) => {
    statusMessage = error instanceof Error ? error.message : String(error);
    statusKind = 'error';
    render();
  });
