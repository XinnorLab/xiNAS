/**
 * Shared polling helpers for the e2e suite.
 *
 * Two readiness families live here, and they are NOT interchangeable:
 *   - `waitForObservation` — agent→api. Something the agent PUSHED has landed
 *     in the api's KV and the route now serves it.
 *   - `waitForAgentReady` — api→agent. The api's heartbeat has reached the
 *     agent, so an apply can dispatch `task.begin` without racing its boot.
 * A test that applies AND reads observed rows needs both.
 *
 * `waitForObservation` used to live (twice, near-identically) inside
 * agent-api-roundtrip.test.ts and nfs-roundtrip.test.ts. Both copies treated
 * "HTTP 200" as "the agent's observation has landed". That holds for a
 * SINGLETON route — /api/v1/nfs-idmap 404s NOT_FOUND until the snapshot is
 * observed — but NOT for a COLLECTION route: /api/v1/users and /api/v1/disks
 * answer 200 with `result: []` from the moment the api is up, so the helper
 * returned an empty list and the caller asserted against nothing.
 *
 * The agent's boot sweep publishes one collector at a time (runBootSequence
 * awaits flushWithSnapshot per collector, in registration order), so the
 * kinds do not arrive together: NfsIdmap is collector #5 and Users is #8.
 * A sequential test that waits on /nfs-idmap and then reads /users is
 * therefore racing the three collectors in between. Measured on this repo,
 * /users answers 200 at t+9ms but carries rows only at t+842ms — 18ms after
 * /nfs-idmap starts answering 200. Under CI load that gap widens and the
 * users assertion fails in ~10ms against [].
 *
 * The fix is a readiness predicate over the parsed response. It defaults to
 * "any 200", which is the correct and unchanged contract for singletons;
 * collection callers pass `collectionNotEmpty`. That is sound because the api
 * applies each observation batch inside a single kv.transaction
 * (src/api/internal/observed.ts) — a collection goes from empty to fully
 * reconciled in one commit, so "non-empty" means the whole batch landed and
 * the caller's own assertions stay meaningful rather than being weakened into
 * the wait.
 */
import * as http from 'node:http';

export interface JsonResponse {
  status: number;
  body: {
    result?: unknown;
    errors?: Array<{ code?: string; details?: { code?: string } }>;
    warnings?: unknown[];
  };
}

/** Decides whether a 200 response already carries the observation being awaited. */
export type ObservationReady = (res: JsonResponse) => boolean;

export interface WaitForObservationOptions {
  /** Overall budget for the poll loop. */
  timeoutMs?: number;
  /**
   * Readiness test applied to every 200. Defaults to accepting any 200, which
   * is right for singleton routes that 404 until observed. Collection routes
   * must pass `collectionNotEmpty` (or a stricter predicate) — a bare 200
   * there means "route is up", not "data has arrived".
   */
  ready?: ObservationReady;
}

/** Readiness for a collection route: the observed rows are actually present. */
export const collectionNotEmpty: ObservationReady = (res) =>
  Array.isArray(res.body.result) && res.body.result.length > 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET over UDS; resolves with the HTTP status + parsed envelope. */
export function getJson(socketPath: string, path: string, token: string): Promise<JsonResponse> {
  return new Promise((resolveP, reject) => {
    const req = http.request(
      { socketPath, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolveP({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Poll a GET route until the observation it exposes has arrived.
 *
 * A 404 with errors[0].code === 'NOT_FOUND' means "not yet observed" → keep
 * waiting. Any other non-200 is a real failure and throws immediately rather
 * than burning the whole budget. A 200 that does not satisfy `ready` is also
 * "not yet observed" → keep waiting.
 */
export async function waitForObservation(
  socketPath: string,
  token: string,
  path: string,
  opts: WaitForObservationOptions = {},
): Promise<JsonResponse> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const ready = opts.ready ?? (() => true);
  const deadline = Date.now() + timeoutMs;
  let last: JsonResponse | null = null;
  while (Date.now() < deadline) {
    const res = await getJson(socketPath, path, token);
    last = res;
    if (res.status === 200) {
      if (ready(res)) return res;
    } else {
      const code = res.body.errors?.[0]?.code;
      if (res.status !== 404 || (code !== undefined && code !== 'NOT_FOUND')) {
        throw new Error(`Unexpected response from ${path}: ${JSON.stringify(res)}`);
      }
    }
    await sleep(200);
  }
  throw new Error(
    `Observation at ${path} never arrived within ${timeoutMs}ms; last=${JSON.stringify(last)}`,
  );
}

/**
 * Readiness for the api→agent dispatch channel, read off /api/v1/system.
 *
 * `node.status.agent` is the live HeartbeatTracker snapshot (src/api/routes/
 * system.ts merges `tracker.currentSnapshot()` in); its `state` is 'offline'
 * until the api's first `agent.health` tick reaches the agent's UDS socket,
 * and any other value means that tick succeeded. Deliberately NOT
 * `node.status.agent_state` — that is the seeded KV field, which the e2e
 * beforeAll writes as 'offline' and nothing ever rewrites.
 *
 * 'degraded' counts as ready: it means the tick is late, not that the socket
 * is gone (src/api/heartbeat.ts §"State table"). During boot the tracker can
 * only leave 'offline' via a successful heartbeat, so the first non-offline
 * state is always 'healthy' anyway.
 */
export const agentNotOffline: ObservationReady = (res) => {
  const state = (
    res.body.result as { node?: { status?: { agent?: { state?: string } } } } | undefined
  )?.node?.status?.agent?.state;
  return state !== undefined && state !== 'offline';
};

export interface WaitForAgentReadyOptions {
  /** Overall budget for the poll loop. */
  timeoutMs?: number;
  /** Extra context appended to the timeout error — typically the agent's stderr. */
  diagnostics?: () => string;
}

/**
 * Block until xinas-agent will accept a task, then return the /system response.
 *
 * Replaces the fixed `sleep(HEARTBEAT_INTERVAL_MS * 3)` that every e2e
 * beforeAll used to run after spawning the agent. That sleep was a guess at
 * the agent's boot time: under load the boot overruns 900ms, the first apply
 * dispatches into a socket nobody is listening on, and `task.begin` fails with
 * 503 INTERNAL / EXECUTOR_UNAVAILABLE ("xinas-agent did not accept the task",
 * src/api/tasks/engine.ts) — taking every test in the file with it.
 *
 * The agent binds its RPC socket and serves task.* BEFORE the boot sweep,
 * which it kicks off unawaited (src/agent-server.ts), so "the api's heartbeat
 * reached the agent" is exactly the precondition `dispatch()` needs. It is
 * also conservative: the tracker can lag the agent coming up, never lead it.
 *
 * Note this waits for the api→agent DIRECTION only. Tests that then read
 * observed rows (disks, filesystems, interfaces) must still wait on those —
 * observations travel agent→api and land later.
 */
export async function waitForAgentReady(
  socketPath: string,
  token: string,
  opts: WaitForAgentReadyOptions = {},
): Promise<JsonResponse> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    return await waitForObservation(socketPath, token, '/api/v1/system', {
      ready: agentNotOffline,
      timeoutMs,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const extra = opts.diagnostics?.() ?? '';
    throw new Error(
      `xinas-agent never became reachable within ${timeoutMs}ms ` +
        `(node.status.agent.state stayed offline/absent): ${detail}` +
        (extra === '' ? '' : `\n--- agent stderr ---\n${extra}`),
    );
  }
}
