/**
 * Typed wrappers for xiRAID gRPC mail notification operations.
 * References: gRPC/protobuf/message_mail.proto
 */

import { callRpc, type XRaidResponse } from './responseParser.js';

export interface MailAddRequest { address: string; level: string }
export interface MailRemoveRequest { address: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcClient = any;

export const mailShow = (client: GrpcClient): Promise<XRaidResponse> =>
  callRpc(client.mailShow.bind(client), {});

export const mailAdd = (client: GrpcClient, req: MailAddRequest): Promise<XRaidResponse> =>
  callRpc(client.mailAdd.bind(client), req);

export const mailRemove = (client: GrpcClient, req: MailRemoveRequest): Promise<XRaidResponse> =>
  callRpc(client.mailRemove.bind(client), req);
