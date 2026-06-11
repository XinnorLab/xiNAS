/**
 * Parse `xicli license show` output (S7 T4, ADR-0009).
 *
 * SECURITY: the raw output is RECOVERABLE LICENSE MATERIAL (the TUI
 * writes it back as the license file). Only this PARSED struct may ever
 * leave the agent — never the text.
 *
 * Format: `key: value` lines (the TUI greps `status:` the same way).
 * Pure; `now` injectable for the days-left computation.
 */

export interface ParsedLicense {
  status: 'active' | 'expired' | 'absent';
  days_left: number | null;
  features: string[];
}

const EXPIRY_KEYS = ['expiration date', 'expiration_date', 'expires', 'expire date'];

export function parseXicliLicense(text: string, now: () => number = Date.now): ParsedLicense {
  const kv = new Map<string, string>();
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    kv.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }

  const rawStatus = (kv.get('status') ?? '').toLowerCase();
  if (rawStatus === '') return { status: 'absent', days_left: null, features: [] };

  let daysLeft: number | null = null;
  for (const key of EXPIRY_KEYS) {
    const value = kv.get(key);
    if (value === undefined) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      daysLeft = Math.floor((parsed - now()) / 86_400_000);
      break;
    }
  }

  const features = (kv.get('levels') ?? kv.get('features') ?? '')
    .split(/[,\s]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  const expired = rawStatus !== 'valid' || (daysLeft !== null && daysLeft < 0);
  return {
    status: expired ? 'expired' : 'active',
    days_left: daysLeft,
    features,
  };
}
