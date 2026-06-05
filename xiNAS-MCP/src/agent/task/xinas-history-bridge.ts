/**
 * xinas_history subprocess bridge (S2 T6, s2-task-envelope-spec §7).
 *
 * The agent (root, TS) shells out to `python3 -m xinas_history` to capture real
 * `snapshot_before` / `snapshot_after` snapshots around an executor's stages.
 * Only snapshot *capture* is bridged here — there is NO rollback method: rollback
 * is executor-provided (each `Executor.rollback()` undoes its own change).
 *
 * `runSubprocess` is injected so unit tests never spawn python; the agent wires
 * the real `execFile`-backed implementation at construction.
 */

/** Result of running a subprocess: captured stdout + the process exit code. */
export interface SubprocessResult {
  stdout: string;
  code: number;
}

/** Injectable subprocess runner: argv[0] is the program, the rest its args. */
export type RunSubprocess = (argv: string[]) => Promise<SubprocessResult>;

export interface XinasHistoryBridgeOptions {
  runSubprocess: RunSubprocess;
  /** Python interpreter program name. Default: 'python3'. */
  python?: string;
}

export class XinasHistoryBridge {
  readonly #runSubprocess: RunSubprocess;
  readonly #python: string;

  constructor(opts: XinasHistoryBridgeOptions) {
    this.#runSubprocess = opts.runSubprocess;
    this.#python = opts.python ?? 'python3';
  }

  /**
   * Create a configuration snapshot and return its id.
   *
   * Runs `python3 -m xinas_history snapshot create --source <source>
   * --operation <operation> --format json` and parses the `{ "id": ... }`
   * object the CLI prints (T6 added `--format json` to `snapshot create`).
   *
   * Throws on a non-zero exit code, unparseable stdout, or a missing/empty id.
   */
  async snapshotCreate(operation: string, source: string): Promise<{ snapshot_id: string }> {
    const argv = [
      this.#python,
      '-m',
      'xinas_history',
      'snapshot',
      'create',
      '--source',
      source,
      '--operation',
      operation,
      '--format',
      'json',
    ];

    const { stdout, code } = await this.#runSubprocess(argv);
    if (code !== 0) {
      throw new Error(
        `xinas_history snapshot create exited with code ${code}: ${stdout.trim() || '<no output>'}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (err) {
      throw new Error(
        `xinas_history snapshot create produced unparseable JSON: ${
          err instanceof Error ? err.message : String(err)
        } (stdout: ${stdout.trim()})`,
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { id?: unknown }).id !== 'string' ||
      (parsed as { id: string }).id.length === 0
    ) {
      throw new Error(
        `xinas_history snapshot create JSON missing a string "id" field: ${stdout.trim()}`,
      );
    }

    return { snapshot_id: (parsed as { id: string }).id };
  }
}
