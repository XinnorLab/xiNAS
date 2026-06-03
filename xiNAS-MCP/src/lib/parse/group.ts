/**
 * Pure parser for a single /etc/group line.
 * Format: name:password:gid:member1,member2,...
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ParsedGroupLine {
  name: string;
  gid: number;
  members: string[];
}

export function parseGroupLine(rawLine: string): ParsedGroupLine {
  // Trim trailing CR so CRLF line endings (e.g. from getent on some systems) don't
  // poison the last field.
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  const fields = line.split(':');
  if (fields.length < 4) {
    throw new Error(
      `parseGroupLine: expected 4 fields, got ${fields.length}: ${JSON.stringify(line)}`,
    );
  }
  const [name, , gidStr, membersStr] = fields as [string, string, string, string];
  if (!/^\d+$/.test(gidStr)) {
    throw new Error(`group line has non-numeric gid: ${JSON.stringify(rawLine)}`);
  }
  const members =
    membersStr === ''
      ? []
      : membersStr
          .split(',')
          .map((m) => m.trim())
          .filter((m) => m !== '');
  return {
    name,
    gid: parseInt(gidStr, 10),
    members,
  };
}
