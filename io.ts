import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../config/env';
import { redis } from '../lib/redis';
import { AppError } from '../lib/errors';
import { authenticateToken } from '../auth/guards';
import type { AccessClaims } from '../auth/tokens';

let io: Server | null = null;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_MIN_INTERVAL_MS = 1000;

type Ack = (response: Record<string, unknown>) => void;

/** Event handlers live in their own modules; they are injected here to keep imports one-way. */
export interface RealtimeHandlers {
  canAccessTrip(auth: AccessClaims, tripId: string): Promise<unknown | null>;
  onCaptainLocation(captainId: string, payload: unknown): Promise<void>;
  onChatSend(auth: AccessClaims, payload: unknown): Promise<unknown>;
  onChatTyping(auth: AccessClaims, payload: unknown): Promise<void>;
  onChatRead(auth: AccessClaims, payload: unknown): Promise<void>;
  onCallEvent(auth: AccessClaims, event: string, payload: unknown): Promise<unknown>;
  onSupportTyping(auth: AccessClaims, payload: unknown): Promise<void>;
}

function asAck(value: unknown): Ack | null {
  return typeof value === 'function' ? (value as Ack) : null;
}

function errorResponse(error: unknown): Record<string, unknown> {
  if (error instanceof AppError) return { ok: false, error: error.code, message: error.message };
  return { ok: false, error: 'SERVER_ERROR', message: 'حدث خطأ، حاول مرة أخرى' };
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
}

export function emitToTrip(tripId: string, event: string, payload: unknown): void {
  io?.to(`trip:${tripId}`).emit(event, payload);
}

export function emitToAdmins(event: string, payload: unknown): void {
  io?.to('admins').emit(event, payload);
}

export function emitToTicket(ticketId: string, event: string, payload: unknown): void {
  io?.to(`ticket:${ticketId}`).emit(event, payload);
}

export async function isUserOnline(userId: string): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(`user:${userId}`).fetchSockets().catch(() => []);
  return sockets.length > 0;
}

function bind(socket: Socket, event: string, handler: (payload: unknown) => Promise<unknown>): void {
  socket.on(event, (payload: unknown, ackValue: unknown) => {
    const ack = asAck(ackValue);
    handler(payload)
      .then((result) => ack?.({ ok: true, ...(result && typeof result === 'object' ? (result as object) : {}) }))
      .catch((error: unknown) => ack?.(errorResponse(error)));
  });
}

export function initRealtime(app: FastifyInstance, handlers: RealtimeHandlers): void {
  const server = new Server(app.server, {
    path: '/socket.io',
    cors: { origin: env.CORS_ORIGINS, credentials: false },
    transports: ['websocket', 'polling'],
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1_000_000,
  });

  server.adapter(createAdapter(redis.duplicate(), redis.duplicate()));

  server.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown }).token;
    if (typeof token !== 'string') {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    authenticateToken(token)
      .then((claims) => {
        socket.data.auth = claims;
        socket.data.lastLocationAt = 0;
        next();
      })
      .catch(() => next(new Error('UNAUTHORIZED')));
  });

  server.on('connection', (socket) => {
    const auth = socket.data.auth as AccessClaims;
    void socket.join(`user:${auth.userId}`);
    if (auth.app === 'ADMIN') void socket.join('admins');

    socket.on('trip:subscribe', (payload: unknown, ackValue: unknown) => {
      const ack = asAck(ackValue);
      const tripId = (payload as { tripId?: unknown } | null)?.tripId;
      if (typeof tripId !== 'string' || !UUID_PATTERN.test(tripId)) {
        ack?.({ ok: false, error: 'INVALID_TRIP' });
        return;
      }
      handlers
        .canAccessTrip(auth, tripId)
        .then(async (view) => {
          if (!view) {
            ack?.({ ok: false, error: 'FORBIDDEN' });
            return;
          }
          await socket.join(`trip:${tripId}`);
          ack?.({ ok: true, trip: view });
        })
        .catch((error: unknown) => {
          app.log.warn({ err: error, tripId }, 'trip subscribe failed');
          ack?.({ ok: false, error: 'SERVER_ERROR' });
        });
    });

    socket.on('trip:unsubscribe', (payload: unknown) => {
      const tripId = (payload as { tripId?: unknown } | null)?.tripId;
      if (typeof tripId === 'string') void socket.leave(`trip:${tripId}`);
    });

    socket.on('ticket:subscribe', (payload: unknown, ackValue: unknown) => {
      const ack = asAck(ackValue);
      const ticketId = (payload as { ticketId?: unknown } | null)?.ticketId;
      if (typeof ticketId !== 'string' || !UUID_PATTERN.test(ticketId)) {
        ack?.({ ok: false, error: 'INVALID_TICKET' });
        return;
      }
      // Users only get their own ticket events through user:<id>; admins join ticket rooms.
      if (auth.app !== 'ADMIN') {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      void socket.join(`ticket:${ticketId}`);
      ack?.({ ok: true });
    });

    socket.on('captain:location', (payload: unknown, ackValue: unknown) => {
      const ack = asAck(ackValue);
      if (auth.app !== 'CAPTAIN') {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      const now = Date.now();
      if (now - (socket.data.lastLocationAt as number) < LOCATION_MIN_INTERVAL_MS) {
        ack?.({ ok: false, error: 'THROTTLED' });
        return;
      }
      socket.data.lastLocationAt = now;
      handlers
        .onCaptainLocation(auth.userId, payload)
        .then(() => ack?.({ ok: true }))
        .catch((error: unknown) => {
          app.log.warn({ err: error }, 'captain location rejected');
          ack?.({ ok: false, error: 'INVALID_LOCATION' });
        });
    });

    bind(socket, 'chat:send', (payload) => handlers.onChatSend(auth, payload));
    bind(socket, 'chat:typing', (payload) => handlers.onChatTyping(auth, payload));
    bind(socket, 'chat:read', (payload) => handlers.onChatRead(auth, payload));
    bind(socket, 'support:typing', (payload) => handlers.onSupportTyping(auth, payload));

    for (const event of ['call:invite', 'call:accept', 'call:decline', 'call:signal', 'call:end']) {
      bind(socket, event, (payload) => handlers.onCallEvent(auth, event, payload));
    }
  });

  io = server;
}

export async function closeRealtime(): Promise<void> {
  const current = io;
  io = null;
  if (!current) return;
  await new Promise<void>((resolve) => {
    current.close(() => resolve());
  });
}
