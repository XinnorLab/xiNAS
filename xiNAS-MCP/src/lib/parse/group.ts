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

export function parseGroupLine(line: string): ParsedGroupLine {
  const fields = line.split(':');
  if (fields.length < 4) {
    throw new Error(
      `parseGroupLine: expected 4 fields, got ${fields.length}: ${JSON.stringify(line)}`,
    );
  }
  const [name, , gidStr, membersStr] = fields as [string, string, string, string];
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
