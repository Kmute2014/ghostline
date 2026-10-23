/**
 * Fire-and-forget notifier: pushes realtime events from Next.js API routes to
 * the socket.io mini-service over a loopback-only HTTP endpoint. Failures are
 * tolerated — clients also poll via TanStack Query.
 */

const INTERNAL_URL = process.env.INTERNAL_NOTIFY_URL ?? 'http://127.0.0.1:3004/notify'
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'ghostline-internal-dev'

async function postNotify(body: Record<string, unknown>, event: string): Promise<void> {
  try {
    const res = await fetch(INTERNAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) {
      console.warn(`[notify] service responded ${res.status} for event=${event}`)
    }
  } catch {
    console.warn(`[notify] service unreachable for event=${event} (clients will poll instead)`)
  }
}

export async function notifyUsers(userIds: string[], event: string, payload: unknown): Promise<void> {
  if (userIds.length === 0) return
  await postNotify({ userIds, event, payload }, event)
}

/**
 * Broadcast to a named socket.io room (e.g. the global "feed" room every
 * connected client joins). Used for Buzz feed events — everyone sees them.
 */
export async function notifyRoom(room: string, event: string, payload: unknown): Promise<void> {
  await postNotify({ rooms: [room], event, payload }, event)
}
