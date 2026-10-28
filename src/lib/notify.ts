/**
 * Fire-and-forget notifier: pushes realtime events from Next.js API routes to
 * Firebase Firestore. The Socket.IO service remains a compatibility transport
 * for presence, typing, and socket-originated messages while the migration is
 * rolled out.
 */
import {
  FieldPath,
} from 'firebase-admin/firestore'
import {
  getFirebaseAdminFirestore,
  publishFirebaseBroadcastEvent,
  publishFirebaseUserEvent,
} from '@/lib/firebase-admin'

const INTERNAL_URL = process.env.INTERNAL_NOTIFY_URL ?? 'http://127.0.0.1:3004/notify'
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'ghostline-internal-dev'

export type NotificationPreference = 'notifyOnChat' | 'notifyWhenPeopleOnline' | 'notifyOnBuzz' | 'notifyOnStories'

export async function filterNotificationRecipients(
  userIds: string[],
  preference: NotificationPreference,
): Promise<string[]> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))]
  if (uniqueIds.length === 0) return []

  const firestore = getFirebaseAdminFirestore()
  const allowed: string[] = []

  for (let offset = 0; offset < uniqueIds.length; offset += 30) {
    const chunk = uniqueIds.slice(offset, offset + 30)
    const snap = await firestore.collection('profiles').where(FieldPath.documentId(), 'in', chunk).get()
    for (const doc of snap.docs) {
      const profile = doc.data() ?? {}
      if (profile[preference] !== false) allowed.push(doc.id)
    }
  }

  return allowed
}

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

  const preferenceByEvent: Partial<Record<string, NotificationPreference>> = {
    'message:new': 'notifyOnChat',
    'stories:update': 'notifyOnStories',
    'buzz:notification': 'notifyOnBuzz',
  }

  const preference = preferenceByEvent[event]
  const recipients = preference ? await filterNotificationRecipients(userIds, preference) : userIds

  if (recipients.length === 0) return

  const [firebaseResult] = await Promise.allSettled([
    publishFirebaseUserEvent(recipients, event, payload),
    postNotify({ userIds: recipients, event, payload }, event),
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
