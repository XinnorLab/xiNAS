/**
 * xiRAID gRPC Client Pool
 *
 * Singleton per controller_id. Reads connection params from /etc/xraid/net.conf.
 * TLS with CA cert from /etc/xraid/crt/ca-cert.{pem,crt}.
 * Retry: 5 attempts, 1s backoff on UNAVAILABLE (mirrors xiRAID CLI constant).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { McpToolError, ErrorCode } from '../types/common.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CRT_DIR = '/etc/xraid/crt';
const NET_CONF_PATH = '/etc/xraid/net.conf';
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 6066;
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

const PROTO_ROOT = path.join(__dirname, '..', '..', 'proto');
const SERVICE_PROTO = path.join(PROTO_ROOT, 'xraid', 'gRPC', 'protobuf', 'service_xraid.proto');

export interface XRaidNetConfig {
  host: string;
  port: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientPool = new Map<string, any>();

export function readNetConfig(): XRaidNetConfig {
  try {
    const raw = fs.readFileSync(NET_CONF_PATH, 'utf8');
    const cfg = JSON.parse(raw) as { host?: string; port?: number };
    return {
      host: cfg.host ?? DEFAULT_HOST,
      port: cfg.port ?? DEFAULT_PORT,
    };
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
}

function readCaCert(): Buffer {
  const candidates = [
    path.join(CRT_DIR, 'ca-cert.pem'),
    path.join(CRT_DIR, 'ca-cert.crt'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  throw new McpToolError(
    ErrorCode.INTERNAL,
    `xiRAID CA cert not found. Tried: ${candidates.join(', ')}. Is xiraid-server.service running?`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createClient(): Promise<any> {
  const netCfg = readNetConfig();
  const caCert = readCaCert();

  const packageDef = protoLoader.loadSync(SERVICE_PROTO, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT, path.join(PROTO_ROOT, 'xraid', 'gRPC', 'protobuf')],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protoDescriptor = grpc.loadPackageDefinition(packageDef) as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const XRAIDService = protoDescriptor.xraid.v2.XRAIDService as grpc.ServiceClientConstructor;

  const credentials = grpc.credentials.createSsl(caCert);
  const channelOptions: grpc.ChannelOptions = {
    'grpc.enable_http_proxy': 0,
  };

  const target = `${netCfg.host}:${netCfg.port}`;
  return new XRAIDService(target, credentials, channelOptions);
}

/**
 * Returns a gRPC client for the given controller. Caches by controller_id.
 * Falls back to 'default' controller using /etc/xraid/net.conf.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getClient(controllerId = 'default'): Promise<any> {
  if (clientPool.has(controllerId)) {
    return clientPool.get(controllerId);
  }
  const client = await createClient();
  clientPool.set(controllerId, client);
  return client;
}

/**
 * Execute a gRPC operation with retry on UNAVAILABLE errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  toolName: string
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const grpcErr = err as grpc.ServiceError & Error;
      if (grpcErr.code === grpc.status.UNAVAILABLE && attempt < MAX_RETRIES - 1) {
        lastError = grpcErr;
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw mapGrpcError(grpcErr, toolName);
    }
  }
  throw mapGrpcError(lastError as (grpc.ServiceError & Error), toolName);
}

function mapGrpcError(err: grpc.ServiceError & Error, context: string): McpToolError {
  const msg = `${context}: ${err.message ?? 'unknown gRPC error'}`;
  switch (err.code) {
    case grpc.status.INVALID_ARGUMENT:
      return new McpToolError(ErrorCode.INVALID_ARGUMENT, msg, err.details);
    case grpc.status.NOT_FOUND:
      return new McpToolError(ErrorCode.NOT_FOUND, msg, err.details);
    case grpc.status.ALREADY_EXISTS:
      return new McpToolError(ErrorCode.CONFLICT, msg, err.details);
    case grpc.status.FAILED_PRECONDITION:
      return new McpToolError(ErrorCode.PRECONDITION_FAILED, msg, err.details);
    case grpc.status.PERMISSION_DENIED:
    case grpc.status.UNAUTHENTICATED:
      return new McpToolError(ErrorCode.PERMISSION_DENIED, msg, err.details);
    case grpc.status.DEADLINE_EXCEEDED:
      return new McpToolError(ErrorCode.TIMEOUT, msg, err.details);
    case grpc.status.RESOURCE_EXHAUSTED:
      return new McpToolError(ErrorCode.RESOURCE_EXHAUSTION, msg, err.details);
    case grpc.status.UNIMPLEMENTED:
      return new McpToolError(ErrorCode.UNSUPPORTED, msg, err.details);
    default:
      return new McpToolError(ErrorCode.INTERNAL, msg, err.details);
  }
}
