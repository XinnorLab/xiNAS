import { type Server, createServer } from 'node:http';
import type { Express } from 'express';
import { onTestFinished } from 'vitest';

/**
 * Start `app` on an ephemeral port bound to 127.0.0.1, and hand supertest the
 * listening server rather than the bare Express app.
 *
 * WHY THIS EXISTS — `request(expressApp)` makes supertest bind a FRESH
 * listener for every single request: it wraps the app in `http.createServer()`
 * and calls `app.listen(0)` with no host, which binds the WILDCARD address
 * (`::` with dual-stack). It then drives the request against
 * `http://127.0.0.1:<port>`.
 *
 * A wildcard bind does not conflict with a loopback-scoped bind on the same
 * port — Node sets SO_REUSEADDR, so `[::]:P` and `127.0.0.1:P` coexist — and
 * the kernel delivers an inbound connection to the MOST SPECIFIC listener. So
 * if any other process on the machine holds `127.0.0.1:P` for a P inside the
 * ephemeral range (macOS: 49152-65535, `sysctl net.inet.ip.portrange.first`),
 * and `listen(0)` is handed that same P, supertest's request goes to that
 * foreign process instead of to the app under test. The app never sees the
 * request, and the test asserts against whatever the squatter answered.
 *
 * That is not hypothetical: VPN helpers (macOS NEPacketTunnelProvider),
 * corporate proxies and debugging tools routinely park loopback listeners in
 * that range, and such a proxy answers `400 Bad Request` with an empty body —
 * which surfaces as a test expecting 412/404/200 receiving 400 with
 * `res.body.errors` undefined. With two squatted ports out of ~16k the odds
 * are ~1e-4 per request, i.e. a few percent per full-suite run, landing on a
 * different test each time and never reproducing in CI. See
 * `docs/troubleshooting/supertest-ephemeral-port-hijack.md`.
 *
 * Binding to 127.0.0.1 removes the ambiguity: the kernel only hands out a port
 * that is free ON THAT ADDRESS, so a squatted port is never selected. A
 * loopback bind resolves the host asynchronously (Node routes any `listen`
 * with a host through `dns.lookup`, IP literals included), so the server has
 * to be started up-front and awaited — supertest reads `server.address().port`
 * synchronously and would see `null` if it did the listen itself. Reusing one
 * listener for every request in a test is also cheaper than binding and
 * closing one per request.
 */
export async function listenLoopback(app: Express): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A test that forgets to close its server must not hold the runner open.
  server.unref();
  return server;
}

/** Close a {@link listenLoopback} server; resolves once it has shut down. */
export function closeLoopback(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * {@link listenLoopback} for a test that builds its own app inline: the
 * listener is closed when the running test finishes, so the call site stays a
 * single expression.
 */
export async function listenLoopbackForTest(app: Express): Promise<Server> {
  const server = await listenLoopback(app);
  onTestFinished(() => closeLoopback(server));
  return server;
}
