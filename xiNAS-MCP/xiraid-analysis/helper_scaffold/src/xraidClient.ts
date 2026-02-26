/**
 * xiRAID gRPC Client Factory
 *
 * Connects to the xiRAID management daemon using TLS gRPC.
 * Connection parameters are read from /etc/xraid/net.conf (JSON).
 * CA certificate is read from /etc/xraid/crt/ca-cert.{pem,crt}.
 *
 * References:
 *   gRPC/xraid_client.py:XNRgRPCClient.authentication()
 *   gRPC/auth.py:get_client_auth_file()
 *   gRPC/constant.py: CRT_DIR, CLIENT_CRT_PATH
 *   core/constant.py: DEFAULT_NET_CONFIG = { host: 'localhost', port: 6066 }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

// --- Constants (mirroring gRPC/constant.py and core/constant.py) ---

const CRT_DIR = '/etc/xraid/crt';
const NET_CONF_PATH = '/etc/xraid/net.conf';

const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = 6066;

// Proto root — adjust to match where you placed the .proto files
const PROTO_ROOT = path.join(__dirname, '..', 'proto');
const SERVICE_PROTO = path.join(PROTO_ROOT, 'xraid', 'gRPC', 'protobuf', 'service_xraid.proto');

// --- Types ---

export interface XRaidNetConfig {
  host: string;
  port: number;
}

export type XRaidServiceStub = Record<string, grpc.requestCallback<grpc.ClientUnaryCall>>;

// --- Connection config reader (mirrors core/configs/high_level_client.py:read_net_config) ---

export function readNetConfig(): XRaidNetConfig {
  try {
    const raw = fs.readFileSync(NET_CONF_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    return {
      host: cfg.host ?? DEFAULT_HOST,
      port: cfg.port ?? DEFAULT_PORT,
    };
  } catch {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
}

// --- CA cert reader (mirrors gRPC/auth.py:get_client_auth_file) ---

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
  throw new Error(
    `xiRAID CA cert not found. Tried: ${candidates.join(', ')}. ` +
    'Is xraid-server.service running and /etc/xraid/crt/ populated?'
  );
}

// --- Client factory ---

/**
 * Creates and returns a connected gRPC stub for XRAIDService.
 *
 * The returned stub exposes every RPC defined in service_xraid.proto.
 * Call pattern: stub.raidShow(request, callback) or promisify with util.promisify.
 *
 * Throws if the CA cert is missing or proto files cannot be loaded.
 */
export async function createXRaidClient(): Promise<grpc.Client> {
  const netCfg = readNetConfig();
  const caCert = readCaCert();

  const packageDef = protoLoader.loadSync(SERVICE_PROTO, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });

  // @grpc/proto-loader returns a PackageDefinition; cast to access the service
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protoDescriptor = grpc.loadPackageDefinition(packageDef) as any;
  const XRAIDService = protoDescriptor.xraid.v2.XRAIDService;

  const credentials = grpc.credentials.createSsl(caCert);
  const channelOptions: grpc.ChannelOptions = {
    'grpc.enable_http_proxy': 0,
  };

  const target = `${netCfg.host}:${netCfg.port}`;
  const client = new XRAIDService(target, credentials, channelOptions);

  return client;
}
