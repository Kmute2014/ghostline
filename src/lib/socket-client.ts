"use client";

import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null
let currentToken: string | null = null

/**
 * Singleton socket connection to the realtime service.
 *
 * - Production (e.g. Render two-service): set NEXT_PUBLIC_REALTIME_URL to the
 *   realtime service origin ("https://ghostline-rt.onrender.com") at BUILD time
 *   — NEXT_PUBLIC_ vars are inlined into the client bundle.
 * - Sandbox: unset → connects same-origin through the Caddy gateway
 *   (XTransformPort=3003), which forwards the full path + query.
 *
 * The server serves engine.io under /rt/socket.io (see mini-services/realtime
 * service.ts) so one public port can also expose /healthz and /notify.
 */
export function getSocket(token: string): Socket {
  if (socket && currentToken === token) return socket
  if (socket) {
    socket.disconnect()
    socket = null
  }
  currentToken = token
  const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL
  socket = io(realtimeUrl || '/?XTransformPort=3003', {
    path: '/rt/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  })
  return socket
}

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
  currentToken = null
}

/** Current handshake token (or empty string when not initialized). */
export function currentSocketToken(): string {
  return currentToken ?? ''
}
