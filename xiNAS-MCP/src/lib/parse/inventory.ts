/**
 * Pure parsers for /proc/cpuinfo and /proc/meminfo. Emits typed
 * inventory snapshots used by the Inventory collector.
 *
 * arch defaults to 'x86_64' because xiNAS only targets x86_64;
 * the probe layer can override from `uname -m` if needed.
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ParsedCpuinfo {
  model?: string;
  cores?: number;
  threads: number;
  arch: string;
}

export interface ParsedMeminfo {
  total_kb: number;
  available_kb: number;
  swap_total_kb: number;
}

export function parseCpuinfo(raw: string, arch = 'x86_64'): ParsedCpuinfo {
  let processorCount = 0;
  let model: string | undefined;
  // Per-socket core count (from the `cpu cores` field, same value in every stanza of a socket)
  let coresPerSocket: number | undefined;
  // Track distinct physical socket IDs for multi-socket systems
  const physicalIds = new Set<string>();
  let hasPhysicalId = false;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === 'processor') {
      processorCount += 1;
    } else if (key === 'model name' && model === undefined) {
      model = value;
    } else if (key === 'cpu cores') {
      if (coresPerSocket === undefined) {
        const n = parseInt(value, 10);
        if (!isNaN(n)) coresPerSocket = n;
      }
    } else if (key === 'physical id') {
      hasPhysicalId = true;
      physicalIds.add(value);
    }
  }

  // Compute total physical cores:
  // - If physical_id lines are present: distinct socket count × cores-per-socket
  // - If no physical_id (VMs, ARM, containers): treat as 1 socket → coresPerSocket
  // - If cpu cores is absent: fall back to logical processor count
  let cores: number | undefined;
  if (coresPerSocket !== undefined) {
    const socketCount = hasPhysicalId ? physicalIds.size : 1;
    cores = socketCount * coresPerSocket;
  }

  return {
    ...(model !== undefined ? { model } : {}),
    ...(cores !== undefined ? { cores } : {}),
    threads: Math.max(processorCount, 1),
    arch,
  };
}

export function parseMeminfo(raw: string): ParsedMeminfo {
  const values: Record<string, number> = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    // Values are "<number> kB" or just "<number>" (for huge pages)
    const valuePart =
      line
        .slice(colonIdx + 1)
        .trim()
        .split(/\s+/)[0] ?? '0';
    const n = parseInt(valuePart, 10);
    if (!isNaN(n)) values[key] = n;
  }

  return {
    total_kb: values['MemTotal'] ?? 0,
    available_kb: values['MemAvailable'] ?? 0,
    swap_total_kb: values['SwapTotal'] ?? 0,
  };
}
