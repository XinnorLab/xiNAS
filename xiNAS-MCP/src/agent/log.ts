export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Emit one JSON object per line to stderr. The agent runs under
 * systemd; journald captures stderr. No secrets should ever be passed
 * in `extra` (callers must redact tokens before logging).
 *
 * Standard fields per spec §Agent logs:
 *   time (rfc3339), level, subsystem, event, + optional extra fields.
 */
export function log(
  level: LogLevel,
  subsystem: string,
  event: string,
  extra?: Record<string, unknown>,
): void {
  const line: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    subsystem,
    event,
    ...(extra ?? {}),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
