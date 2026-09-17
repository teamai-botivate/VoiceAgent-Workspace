import type { Server } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { mediaToken, validateMediaSignature } from './security.js';

export type PendingStream = {
  context: { tenantId: string; followupId: string; callSessionId: string };
  callSid: string | null;
  connected: boolean;
  expires: number;
};

export function installMediaGateway(
  server: Server,
  sockets: WebSocketServer,
  options: {
    baseUrl: string;
    authToken: string;
    pending: Map<string, PendingStream>;
    accept: (phone: WebSocket, entry: PendingStream, token: string) => void;
    reject: (reason: string) => void;
  },
): void {
  server.on('upgrade', (request, socket, head) => {
    const path = request.url ?? '';
    const token = mediaToken(path);
    const entry = token ? options.pending.get(token) : undefined;
    const reason = !entry
      ? 'UNKNOWN_STREAM'
      : !entry.callSid
        ? 'UNBOUND_CALL'
        : entry.connected
          ? 'DUPLICATE_STREAM'
          : entry.expires < Date.now()
            ? 'EXPIRED_STREAM'
            : !validateMediaSignature(
                  options.authToken,
                  options.baseUrl,
                  path,
                  request.headers['x-twilio-signature'],
                )
              ? 'INVALID_SIGNATURE'
              : undefined;
    if (reason || !entry || !token) {
      options.reject(reason ?? 'UNKNOWN_STREAM');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    entry.connected = true;
    try {
      sockets.handleUpgrade(request, socket, head, (phone) => options.accept(phone, entry, token));
    } catch {
      entry.connected = false;
      options.reject('UPGRADE_FAILED');
      socket.destroy();
    }
  });
}
