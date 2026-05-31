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

export function parsePasswdLine(line: string): ParsedPasswdLine {
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
  return {
    name,
    uid: parseInt(uidStr, 10),
    gid: parseInt(gidStr, 10),
    gecos,
    home,
    shell,
  };
}
