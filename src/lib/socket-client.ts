"use client";

import { io, type Socket } from 'socket.io-client'

let socket: Socket | null = null
let currentToken: string | null = null

/**
 * Singleton socket connection to the realtime mini-service through the
 * gateway (never a direct port — the Caddy gateway needs XTransformPort).
 */
export function getSocket(token: string): Socket {
  if (socket && currentToken === token) return socket
  if (socket) {
    socket.disconnect()
    socket = null
  }
  currentToken = token
  socket = io('/?XTransformPort=3003', {
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
