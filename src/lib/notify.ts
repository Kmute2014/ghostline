/**
 * Fire-and-forget notifier: pushes realtime events from Next.js API routes to
 * Firebase Firestore. The Socket.IO service remains a compatibility transport
 * for presence, typing, and socket-originated messages while the migration is
 * rolled out.
 */
import {
  publishFirebaseBroadcastEvent,
  publishFirebaseUserEvent,
} from '@/lib/firebase-admin'

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
  const [firebaseResult] = await Promise.allSettled([
    publishFirebaseUserEvent(userIds, event, payload),
    postNotify({ userIds, event, payload }, event),
  ])
  if (firebaseResult.status === 'rejected') {
    console.error(`[notify] Firebase publish failed for event=${event}:`, firebaseResult.reason)
  }
}

/**
 * Broadcast to a named socket.io room (e.g. the global "feed" room every
 * connected client joins). Used for Buzz feed events — everyone sees them.
 */
export async function notifyRoom(room: string, event: string, payload: unknown): Promise<void> {
  const [firebaseResult] = await Promise.allSettled([
    publishFirebaseBroadcastEvent(room, event, payload),
    postNotify({ rooms: [room], event, payload }, event),
  ])
  if (firebaseResult.status === 'rejected') {
    console.error(`[notify] Firebase publish failed for event=${event}:`, firebaseResult.reason)
  }
}
