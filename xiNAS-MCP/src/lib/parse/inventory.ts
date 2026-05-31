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
  let cores: number | undefined;

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
    } else if (key === 'cpu cores' && cores === undefined) {
      const n = parseInt(value, 10);
      if (!isNaN(n)) cores = n;
    }
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
