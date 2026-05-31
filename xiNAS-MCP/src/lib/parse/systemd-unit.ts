/**
 * Pure INI-style parser for systemd unit files. Sections are
 * `[SectionName]`; keys are `Key=Value`. Repeated keys within the
 * same section are collected into a string[] (multi-value).
 *
 * No side effects. Safe to import from anywhere.
 */

export type SectionMap = Record<string, string | string[]>;

export interface ParsedSystemdUnit {
  unit?: SectionMap;
  mount?: SectionMap;
  service?: SectionMap;
  install?: SectionMap;
  /** Any additional section not covered by the named fields. */
  extra?: Record<string, SectionMap>;
}

function sectionKey(name: string): keyof ParsedSystemdUnit | null {
  switch (name.toLowerCase()) {
    case 'unit':
      return 'unit';
    case 'mount':
      return 'mount';
    case 'service':
      return 'service';
    case 'install':
      return 'install';
    default:
      return null;
  }
}

export function parseSystemdUnit(raw: string): ParsedSystemdUnit {
  const result: ParsedSystemdUnit = {};
  let currentSection: SectionMap | null = null;
  let currentSectionName = '';

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      currentSectionName = line.slice(1, -1);
      const knownKey = sectionKey(currentSectionName);
      if (knownKey !== null) {
        if (result[knownKey] === undefined) {
          (result as Record<string, SectionMap>)[knownKey] = {};
        }
        currentSection = result[knownKey] as SectionMap;
      } else {
        if (result.extra === undefined) result.extra = {};
        if (result.extra[currentSectionName] === undefined) {
          result.extra[currentSectionName] = {};
        }
        currentSection = result.extra[currentSectionName] as SectionMap;
      }
      continue;
    }

    if (currentSection === null) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();

    const existing = currentSection[key];
    if (existing === undefined) {
      currentSection[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      currentSection[key] = [existing, value];
    }
  }

  return result;
}
