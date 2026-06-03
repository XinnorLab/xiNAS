/**
 * Pure parser for a single /etc/passwd line.
 * Format: name:password:uid:gid:gecos:home:shell
 *
 * No side effects. Safe to import from anywhere.
 */

export interface ParsedPasswdLine {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

export function parsePasswdLine(rawLine: string): ParsedPasswdLine {
  // Trim trailing CR so CRLF line endings (e.g. from getent on some systems) don't
  // poison the last field.
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  const fields = line.split(':');
  if (fields.length < 7) {
    throw new Error(
      `parsePasswdLine: expected 7 fields, got ${fields.length}: ${JSON.stringify(line)}`,
    );
  }
  const [name, , uidStr, gidStr, gecos, home, shell] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d+$/.test(uidStr)) {
    throw new Error(`passwd line has non-numeric uid: ${JSON.stringify(rawLine)}`);
  }
  if (!/^\d+$/.test(gidStr)) {
    throw new Error(`passwd line has non-numeric gid: ${JSON.stringify(rawLine)}`);
  }
  return {
    name,
    uid: parseInt(uidStr, 10),
    gid: parseInt(gidStr, 10),
    gecos,
    home,
    shell,
  };
}
