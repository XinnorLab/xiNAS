import { randomUUID } from 'node:crypto';
import type { OpenedStateStore } from '../state/index.js';
import type { Warning } from './envelope.js';

type AgentState = 'healthy' | 'degraded' | 'offline';

export interface HeartbeatTrackerOptions {
  /** How often the api polls agent.health. Default: 5000ms. */
  intervalMs: number;
  controllerId: string;
  state: OpenedStateStore;
  /**
   * Performs one agent.health RPC over the agent UDS and returns the
   * version + collectors map. start() calls this every intervalMs.
   * Injected so tests (J1 mock-agent) supply a fake and never open a
   * real socket. Production wires this to a thin JSON-RPC-over-UDS
   * client against agentSocketPath that sends {"method":"agent.health"}
   * and maps the result. Rejects (ECONNREFUSED/ENOENT) → offline.
   *
   * Optional: only start()'s tick loop uses it. The synchronous
   * state-transition logic (recordHeartbeat*, currentState, …) never
   * touches it, so unit tests that exercise only the state machine
   * construct a tracker without one.
   */
  healthProbe?: () => Promise<{ version?: string; collectors?: Record<string, string> }>;
  /** Path to the agent's UDS socket (used by the production healthProbe). */
  agentSocketPath: string;
}

interface FailureOpts {
  connectRefused?: boolean;
}

/**
 * HeartbeatTracker tracks the live state of the xinas-agent process
 * from the api's perspective. The api ticks the agent every
 * intervalMs via agent.health; the tracker transitions between
 * healthy / degraded / offline based on the time since the last
 * successful response.
 *
 * State table (per spec §"Flow B"):
 *   ≤ 2 × interval since last success  → healthy
 *   > 2 × interval, ≤ 6 × interval     → degraded
 *   > 6 × interval OR connect-refused  → offline
 *
 * currentState() re-evaluates on every call and emits an
 * agent_state_changed event to /xinas/v1/events/<ts>/<id> whenever
 * the computed state differs from the last known state.
 */
export class HeartbeatTracker {
  readonly #opts: HeartbeatTrackerOptions;
  #lastHeartbeatAt: Date | null = null;
  #lastObservationPushAt: Date | null = null;
  #connectRefused = false;
  #knownState: AgentState = 'offline';
  // The constructor-default `offline` is "not yet observed", not an
  // observed-offline event. The first transition out of it (offline →
  // healthy on the first successful heartbeat) is the agent's initial
  // appearance and is NOT broadcast as an agent_state_changed event —
  // only transitions between observed live states are.
  #bootstrapped = false;
  // Captured from the most recent successful agent.health response so
  // currentSnapshot() (consumed by /api/v1/system → result.node.status.agent)
  // can surface the agent version + per-collector health without a fresh RPC.
  #agentVersion: string | null = null;
  #collectors: Record<string, string> = {};
  #tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HeartbeatTrackerOptions) {
    this.#opts = opts;
  }

  /**
   * Record a successful agent.health response. `payload` carries the
   * version + collectors map from the response so currentSnapshot() can
   * report them. Older call sites that pass only `at` still work
   * (version/collectors retain their previous captured values).
   */
  recordHeartbeatSuccess(
    at: Date,
    payload?: { version?: string; collectors?: Record<string, string> },
  ): void {
    this.#lastHeartbeatAt = at;
    this.#connectRefused = false;
    if (payload?.version !== undefined) this.#agentVersion = payload.version;
    if (payload?.collectors !== undefined) this.#collectors = payload.collectors;
    this.currentState(); // trigger transition emit if needed
  }

  recordHeartbeatFailure(at: Date, opts?: FailureOpts): void {
    void at;
    if (opts?.connectRefused) {
      this.#connectRefused = true;
    }
    this.currentState();
  }

  recordObservationPush(at: Date): void {
    this.#lastObservationPushAt = at;
    // Does NOT reset heartbeat state per spec §"Flow A" step 5.
  }

  get lastObservationPushAt(): Date | null {
    return this.#lastObservationPushAt;
  }

  get lastHeartbeatAt(): Date | null {
    return this.#lastHeartbeatAt;
  }

  currentState(): AgentState {
    const newState = this.#computeState();
    if (newState !== this.#knownState) {
      const prev = this.#knownState;
      this.#knownState = newState;
      // Suppress the initial offline → live transition (the agent's
      // first appearance); emit every transition thereafter.
      if (this.#bootstrapped) {
        this.#emitStateChange(prev, newState);
      } else {
        this.#bootstrapped = true;
      }
    }
    return this.#knownState;
  }

  currentWarnings(opts: { routeIsMutating: boolean }): Warning[] {
    const state = this.currentState();
    if (state === 'degraded' && opts.routeIsMutating) {
      return [
        {
          code: 'EXECUTOR_DEGRADED',
          message:
            'The xinas-agent is reachable but not responding to health checks on schedule. ' +
            'Mutating operations may be delayed or unreliable.',
        },
      ];
    }
    return [];
  }

  /**
   * Full agent-state view for /api/v1/system → result.node.status.agent.
   * Pure read; does not perform an RPC. `version` + `collectors` reflect
   * the most recent successful agent.health response (null / {} until the
   * first one lands).
   */
  currentSnapshot(): {
    state: AgentState;
    version: string | null;
    last_heartbeat_at: string | null;
    last_observed_push_at: string | null;
    collectors: Record<string, string>;
  } {
    return {
      state: this.currentState(),
      version: this.#agentVersion,
      last_heartbeat_at: this.#lastHeartbeatAt?.toISOString() ?? null,
      last_observed_push_at: this.#lastObservationPushAt?.toISOString() ?? null,
      collectors: this.#collectors,
    };
  }

  /**
   * Start the periodic heartbeat tick. Every intervalMs the tracker calls
   * the injected `healthProbe()` (a thin agent.health RPC over the agent
   * UDS). Success → recordHeartbeatSuccess(now, payload); connect-refused →
   * recordHeartbeatFailure(now, { connectRefused: true }); any other error →
   * recordHeartbeatFailure(now). Idempotent; safe to call once at api boot.
   *
   * `healthProbe` is provided in HeartbeatTrackerOptions so tests inject a
   * fake (J1's mock-agent) and never open a real socket. unref() the timer
   * so it never keeps the process (or a test runner) alive. Throws if no
   * healthProbe was configured — the tick loop has nothing to poll.
   */
  start(): void {
    if (this.#tickTimer) return;
    const probe = this.#opts.healthProbe;
    if (probe === undefined) {
      throw new Error('HeartbeatTracker.start(): no healthProbe configured');
    }
    const tick = async (): Promise<void> => {
      try {
        const payload = await probe();
        this.recordHeartbeatSuccess(new Date(), payload);
      } catch (err) {
        const connectRefused = err instanceof Error && /ECONNREFUSED|ENOENT/.test(err.message);
        this.recordHeartbeatFailure(
          new Date(),
          connectRefused ? { connectRefused: true } : undefined,
        );
      }
    };
    this.#tickTimer = setInterval(() => void tick(), this.#opts.intervalMs);
    if (typeof this.#tickTimer.unref === 'function') this.#tickTimer.unref();
    // Fire one tick immediately so a freshly-started agent is detected
    // without waiting a full interval.
    void tick();
  }

  stop(): void {
    if (this.#tickTimer) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
  }

  #computeState(): AgentState {
    if (this.#connectRefused) return 'offline';
    if (this.#lastHeartbeatAt === null) return 'offline';

    const nowMs = Date.now();
    const elapsedMs = nowMs - this.#lastHeartbeatAt.getTime();
    const { intervalMs } = this.#opts;

    if (elapsedMs <= 2 * intervalMs) return 'healthy';
    if (elapsedMs <= 6 * intervalMs) return 'degraded';
    return 'offline';
  }

  #emitStateChange(from: AgentState, to: AgentState): void {
    const ts = new Date().toISOString();
    const eventId = randomUUID();
    const key = `/xinas/v1/events/${ts}/${eventId}`;
    try {
      this.#opts.state.kv.put(key, {
        kind: 'agent_state_changed',
        controller_id: this.#opts.controllerId,
        from,
        to,
        reason: to === 'offline' && this.#connectRefused ? 'connect_refused' : 'heartbeat_timeout',
        last_successful_heartbeat_at: this.#lastHeartbeatAt?.toISOString() ?? null,
      });
    } catch (_err) {
      // Best-effort: event emission failure does not affect tracker state.
    }
  }
}
