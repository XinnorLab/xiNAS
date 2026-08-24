# supertest: a loopback squatter stole test requests via wildcard `listen(0)`

## TL;DR

`request(expressApp)` makes supertest bind a **fresh** listener for every
request, using a host-less `app.listen(0)` — which binds the **wildcard**
address. A wildcard bind does not conflict with a loopback-scoped bind on the
same port, and the kernel delivers a connection to the **most specific**
listener. So whenever `listen(0)` was handed a port that another process
already held on `127.0.0.1`, supertest's own request went to that process
instead of to the app under test. On the affected machine a VPN helper
(`PacketTunnelProvider`) held `127.0.0.1:55531` and `127.0.0.1:55532` — both
inside the macOS ephemeral range (49152-65535) — and answered
`400 Bad Request` with an empty body. Fixed by starting one loopback-bound
server per test and handing supertest the listening server
([`src/__tests__/_listen.ts`](../../xiNAS-MCP/src/__tests__/_listen.ts)).

## Symptoms

- A single test fails per run, on a **different** test each time, always with a
  status the route cannot produce for that request — e.g.
  `AssertionError: expected 400 to be 412` in `routes-arrays.test.ts`
  (`DELETE /arrays/:id` mode=apply), or
  `TypeError: Cannot read properties of undefined (reading '0')` on
  `res.body.errors[0]` in `internal-observed-schema.test.ts`.
- Roughly a few percent of full-suite runs; never reproducible standalone.
- **Never** reproduces in CI, and the same checkout is green on another machine.
- Timing profile of a failing run is unremarkable — same duration, same
  per-file timings as a green run. It is not a load or starvation effect.

## How it was confirmed

The api logs an `INVALID_ARGUMENT` for every 400 it produces. In a failing run
the expected log entry was **missing**: the client got a 400 the application
never generated. The response also carried `proxy-connection: close`,
`content-length: 0` and no `content-type` — not the api's envelope, and not
Node's own `clientError` reply either.

`lsof -nP -iTCP -sTCP:LISTEN` then showed the squatter, and the mechanism
reproduces deterministically:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep 127.0.0.1     # find a loopback-only listener
```

```js
// with a foreign process already holding 127.0.0.1:55531
const server = http.createServer(app);
server.listen(55531);                  // succeeds: binds [::]:55531
http.request({ host: '127.0.0.1', port: 55531, ... });
// → 400 Bad Request, empty body, from the OTHER process
```

Binding the same port host-scoped instead fails outright
(`listen(55531, '127.0.0.1')` → `EADDRINUSE`), which is exactly why the fix
works: the kernel only hands out an ephemeral port that is free **on that
address**, so a squatted port is never selected.

## Root cause

1. Node sets `SO_REUSEADDR`, so `[::]:P` (wildcard) and `127.0.0.1:P`
   (loopback-scoped) can be bound at the same time by different processes.
2. For an inbound connection to `127.0.0.1:P` the kernel picks the most
   specific listener — the foreign one.
3. supertest binds host-less and connects to `127.0.0.1`, so it is exposed to
   this on every single request. With two squatted ports out of ~16k the odds
   are ~1e-4 per request, i.e. a few percent per full-suite run, landing on a
   different test every time.

This is a property of the machine (a VPN, corporate proxy or debugging tool
parking a loopback listener in the ephemeral range), not of the code under
test — which is why CI never saw it.

## Fix

- `src/__tests__/_listen.ts` — `listenLoopback(app)` starts the app on
  `127.0.0.1:0` and returns the listening server;
  `listenLoopbackForTest(app)` also closes it when the test finishes.
  supertest accepts a listening server and reuses it instead of binding its
  own, so every request reaches the app it was aimed at.
- `src/__tests__/_setup/no-wildcard-listen.ts` (wired as a vitest
  `setupFiles`) throws on a host-less `listen(0)`, so the pattern cannot come
  back unnoticed. A test that genuinely wants every interface names the host.

The suite also got roughly twice as fast: it no longer binds and tears down a
listener per request.

## If you hit something like this again

A response the application demonstrably never produced means the request did
not reach it. Check for a foreign listener on the port before suspecting the
code:

```bash
lsof -nP -iTCP -sTCP:LISTEN | awk '$9 ~ /127.0.0.1:(4915[2-9]|49[2-9][0-9]{2}|[5-6][0-9]{4})/'
```
