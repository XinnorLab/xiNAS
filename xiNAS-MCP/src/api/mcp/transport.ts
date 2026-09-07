/**
 * The /mcp Streamable HTTP transport (S8 T7, ADR-0010 §transports).
 *
 * Mounted on the api express app itself — every listener (primary UDS
 * or TCP, plus the optional dedicated `config.mcp.http` listener)
 * serves it. JSON response mode (`enableJsonResponse`) keeps the
 * protocol stdio-adapter-friendly: one POST in, one JSON out.
 *
 * Identity resolves ONCE per session at initialize:
 *   bearer → config.tokens (viewer/operator/admin; internal_agent is
 *   refused — the agent has no business on the MCP surface; a token
 *   scoped `surface: 'rest'` is refused with the same 401 an unknown
 *   bearer gets, S15 §3.5);
 *   no bearer over UDS → local_admin (ADR-0001: the socket mode is
 *   the gate); no bearer over TCP → 401.
 *
 * The session's tool calls then replay through the loopback with that
 * identity (dispatch.ts). `ctx.loopback_fn` is injected by server.ts
 * AFTER the primary listener binds; /mcp answers 503 until then.
 *
 * S14 adds the MCP **modern protocol era** on the same endpoint. A modern
 * request (`server/discover`, or any method declaring a modern version in
 * `params._meta`) is answered statelessly by modern.ts BEFORE the SDK
 * session machinery is consulted: identity resolves per request, no session
 * is opened and no Mcp-Session-Id is returned. Everything else is legacy and
 * reaches the SDK transport exactly as it did before, so `initialize` keeps
 * negotiating only the versions the SDK knows — never a modern one.
 * See `docs/control-path/s14-mcp-modern-era-spec.md`.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type Request, type Response } from 'express';
import type { ApiContext } from '../context.js';
import { queueCursorGap } from '../events/audit.js';
import { feedProvider } from '../events/feeds.js';
import { McpProtocolError } from './confirmation/errors.js';
import { elicitationModes } from './confirmation/policy.js';
import { acceptFeeds, openHttpListen, validateListenParams } from './listen.js';
import type { ResourceProvider, ResourcesOptions } from './resources.js';
import { appsProvider } from './apps.js';
import { type McpIdentity, buildMcpServer } from './dispatch.js';
import { handleModernRequest, isModernRequest, isNotification, rpcIdOf } from './modern.js';
import { parseTasksCapability, validateTaskMethodHeaders } from './tasks/index.js';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

function resolveIdentity(req: Request, ctx: ApiContext): McpIdentity | null {
  const authHeader = req.header('authorization');
  if (authHeader !== undefined && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const principal = ctx.config.tokens[token];
    if (principal === undefined) return null;
    // A1 (S15 §3.5): a REST-scoped token is not an MCP credential. Returning
    // null (rather than a distinct error) makes the caller answer the SAME
    // 401 an unknown bearer gets — a scoped token must not be an oracle for
    // "this token exists, just not here".
    if (principal.surface === 'rest') return null;
    if (
      principal.role !== 'viewer' &&
      principal.role !== 'operator' &&
      principal.role !== 'admin'
    ) {
      return null; // internal_agent etc. — not an MCP principal
    }
    return { principal: principal.principal, role: principal.role };
  }
  // UDS without a bearer: the socket file mode is the gate (ADR-0001).
  if (!req.socket.remoteAddress) {
    return { principal: 'mcp:local_admin', role: 'admin' };
  }
  return null;
}

/**
 * S17 §9.3: the credential a listener was opened with is re-resolved before
 * every delivery. A bearer is looked up again in the token table (a removed
 * or demoted token stops delivery); the UDS local-admin gate has nothing to
 * re-check beyond the socket mode that admitted it.
 */
function reauthorizer(req: Request, ctx: ApiContext): () => boolean {
  const authHeader = req.header('authorization');
  if (authHeader !== undefined && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    return () => {
      const principal = ctx.config.tokens[token];
      return (
        principal !== undefined &&
        // A1: re-scoping a live token to `rest` is a demotion off this
        // surface, and stops delivery like a removal or a role demotion.
        principal.surface !== 'rest' &&
        (principal.role === 'viewer' || principal.role === 'operator' || principal.role === 'admin')
      );
    };
  }
  return () => !req.socket.remoteAddress;
}

export function mountMcpTransport(app: Express, ctx: ApiContext): void {
  const sessions = new Map<string, McpSession>();

  // S17 §3 + S18: the modern-era resource surface always exists — the S18
  // MCP Apps view is a provider unconditionally; the S17 feeds join it only
  // when the journal is installed AND `mcp.subscriptions.enabled`, and
  // `subscribe` says whether they did (a partial feed surface is never
  // advertised). Without the feeds `subscriptions/listen` stays -32601.
  const events = ctx.events;
  const feeds: ResourceProvider[] =
    events !== undefined && events.subscriptions.enabled
      ? [
          feedProvider(events, {
            hooks: {
              onRead: (feed, outcome) => events.metrics.eventRead(feed, outcome),
              onGap: (info, readCtx) => {
                events.metrics.cursorGap(info.feed);
                queueCursorGap(ctx.state.audit, {
                  principal: readCtx.identity.principal,
                  correlationId: readCtx.correlationId,
                  feed: info.feed,
                  requestedSequence: info.requestedSequence,
                  oldestSequence: info.oldestSequence,
                });
              },
              isRdmaConfigured: () => {
                const row = ctx.state.kv.get<{ spec?: { rdma?: { enabled?: unknown } } }>(
                  '/xinas/v1/desired/NfsProfile/default',
                );
                return row?.value.spec?.rdma?.enabled === true;
              },
            },
          }),
        ]
      : [];
  const resources: ResourcesOptions = {
    providers: [...feeds, appsProvider()],
    subscribe: feeds.length > 0,
  };

  // /mcp is mounted ahead of the app-wide express.json(), so it needs its
  // own parser: the modern-era path (S14) has to read `method` and
  // `params._meta` to classify the request BEFORE deciding whether the SDK
  // transport should see it at all. The SDK transport accepts the same
  // pre-parsed body, which is what it was already being handed.
  //
  // The limit is the SDK's own MAXIMUM_MESSAGE_SIZE rather than the api-wide
  // 1 MB: the Streamable HTTP transport imposes no limit of its own, so a
  // tighter cap here would be a behavior change for legacy clients — and
  // "a legacy client retains its existing behavior" is an acceptance
  // criterion (s14 §8, AC13). 4 MB still bounds the endpoint; the largest
  // real tool argument in the catalog is orders of magnitude below it.
  // A11(j): mounted on the JSON-RPC route itself, NOT on the `/mcp` PREFIX.
  // The prefix form also fronted the public, unauthenticated approval-page
  // shell at `/mcp/approvals/*` (S15 §9.3) — a GET that carries no body, so
  // the parser did nothing useful there while still handing anything that
  // arrived with a JSON content-type to the body parser before any of our
  // code ran.
  const jsonBody = express.json({ limit: '4mb' });

  app.post('/mcp', jsonBody, (req: Request, res: Response) => {
    void (async () => {
      if (ctx.loopback_fn === undefined) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'MCP transport not ready (api still starting)' },
          id: null,
        });
        return;
      }

      // ── modern protocol era (S14) ──────────────────────────────────
      // Stateless: no session is opened, no Mcp-Session-Id is returned,
      // and a session id carried by the caller is ignored rather than
      // used to route this into the legacy path.
      //
      // Auth runs FIRST and answers 401 on failure. It must never fall
      // through to the -32601 below: `Method not found` on
      // `server/discover` is the one signal a client may read as "this
      // server is legacy-only", and returning it for a bad token would
      // silently downgrade every such client (requirement §2.5.7-8).
      if (isModernRequest(req.body)) {
        const modernIdentity = resolveIdentity(req, ctx);
        if (modernIdentity === null) {
          res.status(401).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'unauthorized (unknown or missing bearer)' },
            id: null,
          });
          return;
        }
        if (isNotification(req.body)) {
          res.status(202).end();
          return;
        }

        // ── S17 §5: subscriptions/listen is the one modern method answered
        // with an SSE stream. Every pre-acknowledgment failure is JSON.
        if ((req.body as { method?: unknown }).method === 'subscriptions/listen') {
          const correlationId = randomUUID();
          res.setHeader('X-Correlation-ID', correlationId);
          const rawId = (req.body as { id?: unknown }).id;
          const jsonError = (
            status: number,
            code: number,
            message: string,
            data?: Record<string, unknown>,
          ): void => {
            res.status(status).json({
              jsonrpc: '2.0',
              id: typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null,
              error: { code, message, ...(data !== undefined ? { data } : {}) },
            });
          };
          const registry = events?.registry;
          // Without the S17 feeds (`subscribe` false) there is nothing to listen
          // to: method not found, exactly as before S18 added the view provider.
          if (!resources.subscribe || registry === undefined || events === undefined) {
            jsonError(200, -32601, 'method not found: subscriptions/listen');
            return;
          }
          if (typeof rawId !== 'string' && typeof rawId !== 'number') {
            jsonError(
              200,
              -32600,
              'invalid request: subscriptions/listen requires a string or number id',
            );
            return;
          }
          const accept = (req.header('accept') ?? '').toLowerCase();
          if (!accept.includes('text/event-stream') && !accept.includes('*/*')) {
            jsonError(406, -32600, 'invalid request: Accept must include text/event-stream');
            return;
          }
          let feeds: ReturnType<typeof acceptFeeds>;
          try {
            const filter = validateListenParams(
              (req.body as { params?: unknown }).params,
              events.subscriptions.max_uris_per_listen,
            );
            feeds = acceptFeeds(filter, resources.providers, {
              identity: modernIdentity,
              correlationId,
            });
          } catch (err) {
            if (err instanceof McpProtocolError) {
              jsonError(err.httpStatus, err.code, err.message, err.data);
              return;
            }
            throw err;
          }
          const opened = openHttpListen({
            req,
            res,
            id: rawId,
            feeds,
            identity: modernIdentity,
            reauthorize: reauthorizer(req, ctx),
            registry,
            config: events.subscriptions,
            correlationId,
          });
          if (!opened.ok) {
            jsonError(200, -32000, 'subscription limit reached', {
              limit: opened.reason === 'principal_limit' ? 'principal' : 'process',
            });
          }
          return;
        }

        // S16 §3.1: the Tasks capability is read from THIS request; a
        // malformed declaration is -32602. S16 §5.6: the task methods must
        // carry agreeing Mcp-Method / Mcp-Name headers (-32020, HTTP 400).
        // Both run before the handler so an unauthorized task id is never
        // examined for a client that cannot use the extension anyway.
        const meta = (req.body as { params?: { _meta?: unknown } })?.params?._meta;
        let clientTasks = false;
        try {
          clientTasks = parseTasksCapability(meta);
          validateTaskMethodHeaders((name) => req.header(name), req.body);
        } catch (err) {
          if (!(err instanceof McpProtocolError)) throw err;
          res.status(err.httpStatus).json({
            jsonrpc: '2.0',
            id: rpcIdOf(req.body),
            error: {
              code: err.code,
              message: err.message,
              ...(err.data !== undefined ? { data: err.data } : {}),
            },
          });
          return;
        }

        // F5 (fix round 1): the correlation id is server-owned — /mcp never
        // runs requestIdMiddleware (mountMcpTransport is called before
        // app.use(requestIdMiddleware()) in app.ts, whose "Middleware order
        // rationale" comment spells this out: "Audit skips /mcp; auth does
        // not run for /mcp"), so req.context is never populated on this
        // path. Mint the correlation id here instead, and echo it the way
        // X-Correlation-ID is echoed on the REST path. Never the JSON-RPC
        // envelope `id`, which is client-chosen and unbounded.
        const correlationId = randomUUID();
        const { httpStatus, ...body } = await handleModernRequest(
          req.body,
          {
            loopback: (r) => (ctx.loopback_fn as NonNullable<typeof ctx.loopback_fn>)(r),
            loopbackToken: () => ctx.loopback_token,
            allowApply: () => ctx.config.mcp?.allow_apply === true,
            identity: () => modernIdentity,
            client: {
              era: 'modern',
              elicitation: elicitationModes(
                (req.body as { params?: { _meta?: unknown } })?.params?._meta,
              ),
              tasks: clientTasks,
            },
            ...(ctx.mcpConfirmations !== undefined ? { confirmations: ctx.mcpConfirmations } : {}),
            resources,
            ...(ctx.mcpTasks !== undefined ? { tasks: ctx.mcpTasks } : {}),
          },
          correlationId,
        );
        res.setHeader('X-Correlation-ID', correlationId);
        res.status(httpStatus ?? 200).json(body);
        return;
      }

      const sessionId = req.header('mcp-session-id');
      if (sessionId !== undefined && sessions.has(sessionId)) {
        await (sessions.get(sessionId) as McpSession).transport.handleRequest(req, res, req.body);
        return;
      }

      // New session: only an initialize request may open one.
      const identity = resolveIdentity(req, ctx);
      if (identity === null) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'unauthorized (unknown or missing bearer)' },
          id: null,
        });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, server });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
      };

      const server = buildMcpServer({
        loopback: (r) => (ctx.loopback_fn as NonNullable<typeof ctx.loopback_fn>)(r),
        loopbackToken: () => ctx.loopback_token,
        allowApply: () => ctx.config.mcp?.allow_apply === true,
        identity: () => identity,
        // Legacy clients never satisfy isConfirmable's era check (dispatch.ts
        // returns MCP_CONFIRMATION_UNSUPPORTED first) — no elicitation and no
        // confirmations service needed on this path. Likewise a legacy
        // client never declares the Tasks extension (S16 §3.1 reads it per
        // request; there is no per-request _meta agreement on this path).
        client: { era: 'legacy', elicitation: new Set(), tasks: false },
      });
      // exactOptionalPropertyTypes friction in the SDK's Transport
      // interface (same cast the legacy server used).
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, req.body);
    })().catch((err: unknown) => {
      // A8: same rule as modern.ts's catch — an unexpected throw here is
      // never text written for a client, so log it and answer with a fixed
      // string rather than putting the original on the /mcp wire.
      console.error(
        'mcp: unhandled error on POST /mcp:',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
    });
  });

  app.delete('/mcp', (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const session = sessionId !== undefined ? sessions.get(sessionId) : undefined;
    if (session === undefined) {
      res.status(404).end();
      return;
    }
    void session.transport.close().finally(() => {
      if (sessionId !== undefined) sessions.delete(sessionId);
      res.status(200).end();
    });
  });

  // JSON response mode has no server-push stream.
  app.get('/mcp', (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'GET stream unsupported (JSON response mode)' },
      id: null,
    });
  });
}
