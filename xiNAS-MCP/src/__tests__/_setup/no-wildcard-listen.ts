/**
 * Fail fast when a test binds a listener without naming a host.
 *
 * A host-less `listen(0)` binds the WILDCARD address, and a wildcard bind does
 * not conflict with a loopback-scoped bind on the same port — Node sets
 * SO_REUSEADDR, so `[::]:P` and `127.0.0.1:P` coexist, and the kernel delivers
 * an inbound connection to the MOST SPECIFIC listener. Any process that holds
 * `127.0.0.1:P` for a P inside the ephemeral range (macOS: 49152-65535) then
 * silently steals requests aimed at the test server. VPN helpers and local
 * proxies park listeners there routinely, and one answering `400 Bad Request`
 * is what a test sees instead of its own app's response — a rare, machine-
 * specific flake that never reproduces in CI. See
 * `docs/troubleshooting/supertest-ephemeral-port-hijack.md`.
 *
 * `request(expressApp)` is the usual way to reintroduce this: supertest binds a
 * fresh host-less listener per request. Use `listenLoopback()` /
 * `listenLoopbackForTest()` from `src/__tests__/_listen.ts` and hand supertest
 * the listening server instead. A test that genuinely wants every interface can
 * say so by passing the host explicitly (`listen(0, '0.0.0.0')`).
 */
import net from 'node:net';

type RawListen = (this: net.Server, ...args: unknown[]) => net.Server;

const originalListen = net.Server.prototype.listen as unknown as RawListen;

/** `listen(0)`, `listen(0, cb)` and `listen({ port: 0 })` — the shapes that
 *  leave the host unset and therefore bind the wildcard address. */
function isHostless(args: unknown[]): boolean {
  const [first, second] = args;
  if (first === 0) return second === undefined || typeof second === 'function';
  if (typeof first === 'object' && first !== null) {
    const opts = first as net.ListenOptions;
    return opts.port === 0 && opts.host === undefined && opts.path === undefined;
  }
  return false;
}

const guardedListen: RawListen = function guardedListen(
  this: net.Server,
  ...args: unknown[]
): net.Server {
  if (isHostless(args)) {
    throw new Error(
      'listen(0) without a host binds the wildcard address, which lets any ' +
        'process holding that port on 127.0.0.1 intercept the request. Start ' +
        "the server with listenLoopback() from 'src/__tests__/_listen.ts' and " +
        'pass the listening server to supertest, or name the host explicitly.',
    );
  }
  return originalListen.apply(this, args);
};

net.Server.prototype.listen = guardedListen as unknown as net.Server['listen'];
