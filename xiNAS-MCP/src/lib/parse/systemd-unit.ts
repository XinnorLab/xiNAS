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

  // Pre-process: join backslash-continued lines (systemd trailing-\ continuation).
  // A line ending with \ is joined to the next line with a space; this is done
  // before section/key parsing so that continued ExecStart= values are handled
  // correctly even when repeated-key → array folding applies.
  const rawLines = raw.split('\n');
  const lines: string[] = [];
  let i = 0;
  while (i < rawLines.length) {
    let line = rawLines[i] ?? '';
    i += 1;
    // Join continuation lines
    while (line.trimEnd().endsWith('\\')) {
      // Strip trailing backslash AND any whitespace before it, then join
      // the next line (trimmed of leading/trailing whitespace) with a single space.
      line = line.trimEnd().slice(0, -1).trimEnd();
      const next = rawLines[i];
      if (next === undefined) break;
      i += 1;
      line = line + ' ' + next.trim();
    }
    lines.push(line);
  }

  for (const rawLine of lines) {
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
