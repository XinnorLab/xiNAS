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
 *
 * S9 (ADR-0011) adds the READ verbs (`snapshotList`, `snapshotDiff`) and
 * the one rollback that exists (`resetToBaseline`); targeted rollback
 * remains deferred to a future slice.
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

/** One snapshot manifest as `snapshot list --format json` prints it. */
export interface HistoryManifest {
  id: string;
  timestamp: string;
  user?: string;
  source?: string;
  status?: string;
  type?: string;
  preset?: string;
  operation?: string;
  rollback_class?: string;
  parent_id?: string;
  diff_summary?: string;
  // S11 (ADR-0013): display blast-radius hint + restorability signal.
  files_changed?: string[];
  restorable?: boolean;
  [k: string]: unknown;
}

/**
 * The PUBLIC ConfigSnapshot row projected from a manifest (ADR-0011
 * projection table — typed top-level fields, no status bag).
 */
export interface ProjectedSnapshot {
  snapshot_id: string;
  kind: 'baseline' | 'before' | 'after' | 'imported';
  created_at: string;
  principal: string | null;
  rollback_classification: string | null;
  history_type: string | null;
  operation: string | null;
  source: string | null;
  diff_summary: string | null;
  // S11 (ADR-0013): display blast-radius hint + targeted-restore gate.
  files_changed: string[];
  restorable: boolean;
}

/** history SnapshotType → public ConfigSnapshot.kind (ADR-0011 §projection). */
export function projectSnapshot(manifest: HistoryManifest): ProjectedSnapshot {
  const kind =
    manifest.type === 'baseline'
      ? 'baseline'
      : manifest.type === 'rollback_eligible'
        ? 'after'
        : manifest.type === 'ephemeral'
          ? 'before'
          : 'imported';
  return {
    snapshot_id: manifest.id,
    kind,
    created_at: manifest.timestamp,
    principal: manifest.user ?? null,
    rollback_classification: manifest.rollback_class ?? null,
    history_type: manifest.type ?? null,
    operation: manifest.operation ?? null,
    source: manifest.source ?? null,
    diff_summary: manifest.diff_summary ?? null,
    files_changed: Array.isArray(manifest.files_changed) ? manifest.files_changed : [],
    restorable: manifest.restorable === true,
  };
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

  /** Run an argv expecting JSON on stdout; throw on exit/parse failures. */
  async #runJson(argv: string[], what: string): Promise<unknown> {
    const { stdout, code } = await this.#runSubprocess(argv);
    if (code !== 0) {
      throw new Error(`${what} exited with code ${code}: ${stdout.trim() || '<no output>'}`);
    }
    try {
      return JSON.parse(stdout.trim());
    } catch (err) {
      throw new Error(
        `${what} produced unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** All snapshot manifests (`snapshot list --format json`). */
  async snapshotList(): Promise<HistoryManifest[]> {
    const parsed = await this.#runJson(
      [this.#python, '-m', 'xinas_history', 'snapshot', 'list', '--format', 'json'],
      'xinas_history snapshot list',
    );
    if (!Array.isArray(parsed)) {
      throw new Error('xinas_history snapshot list did not return an array');
    }
    return parsed.filter(
      (m): m is HistoryManifest =>
        typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string',
    );
  }

  /** Structured diff between two snapshots (`snapshot diff --format json`). */
  snapshotDiff(from: string, to: string): Promise<unknown> {
    return this.#runJson(
      [this.#python, '-m', 'xinas_history', 'snapshot', 'diff', from, to, '--format', 'json'],
      'xinas_history snapshot diff',
    );
  }

  /**
   * Execute the baseline reset (the runner's own pre-change snapshot,
   * validation, and auto-rollback are the host-side safety). Returns the
   * runner result; `success: false` is the executor's failure signal.
   */
  async resetToBaseline(reason: string): Promise<{ success: boolean; [k: string]: unknown }> {
    const parsed = await this.#runJson(
      [
        this.#python,
        '-m',
        'xinas_history',
        'snapshot',
        'reset-to-baseline',
        '--reason',
        reason,
        '--yes',
        '--format',
        'json',
      ],
      'xinas_history snapshot reset-to-baseline',
    );
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('reset-to-baseline did not return an object');
    }
    return parsed as { success: boolean; [k: string]: unknown };
  }

  /**
   * S11 (ADR-0013): targeted file-level restore of an arbitrary snapshot's
   * captured NFS/network config bytes (observed recovery). The python runner
   * owns the transactional safety + file-level auto-rollback.
   */
  async restoreSnapshot(
    snapshotId: string,
    reason: string,
  ): Promise<{ success: boolean; snapshot_id?: string; error?: string; [k: string]: unknown }> {
    const parsed = await this.#runJson(
      [
        this.#python,
        '-m',
        'xinas_history',
        'snapshot',
        'restore',
        snapshotId,
        '--reason',
        reason,
        '--source',
        'api',
        '--yes',
        '--format',
        'json',
      ],
      'xinas_history snapshot restore',
    );
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('snapshot restore did not return an object');
    }
    return parsed as { success: boolean; snapshot_id?: string; error?: string };
  }
}
