/**
 * Pure parser for /etc/idmapd.conf. Reuses parseSystemdUnit (which
 * handles the same [Section]\nKey=Value INI dialect) to extract
 * the fields the NfsIdmap collector cares about.
 *
 * No side effects. Safe to import from anywhere.
 */

import { parseSystemdUnit } from './systemd-unit.js';

export interface ParsedIdmapConf {
  domain?: string;
  local_realms?: string[];
  method?: string;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

export function parseIdmapConf(raw: string): ParsedIdmapConf {
  // idmapd.conf uses the same INI dialect as systemd unit files.
  // Section names differ (General / Mapping / Translation) so they
  // land in the 'extra' bucket of ParsedSystemdUnit.
  const parsed = parseSystemdUnit(raw);
  const general = parsed.extra?.['General'] ?? {};
  const mapping = parsed.extra?.['Mapping'] ?? {};

  const domainRaw = firstString(general['Domain']);
  const localRealmsRaw = firstString(general['Local-Realms']);
  const methodRaw = firstString(mapping['Method']);

  const local_realms =
    localRealmsRaw !== undefined
      ? localRealmsRaw
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r !== '')
      : undefined;

  return {
    ...(domainRaw !== undefined ? { domain: domainRaw } : {}),
    ...(local_realms !== undefined ? { local_realms } : {}),
    ...(methodRaw !== undefined ? { method: methodRaw } : {}),
  };
}
