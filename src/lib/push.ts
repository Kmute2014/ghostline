/**
 * Server-side Web Push (VAPID) helper for Next.js API routes.
 * The realtime mini-service maintains its own copy of this logic.
 */
import webpush from 'web-push'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'

export type PushPayload = {
  title: string
  body: string
  tag?: string
  /** Deep-link path opened when the notification is tapped, e.g. /?chat=<id> */
  url?: string
}

let configured: boolean | null = null

/** Configures web-push once; returns false when VAPID env is missing/invalid. */
export function isPushConfigured(): boolean {
  if (configured === null) {
    const publicKey = process.env.VAPID_PUBLIC_KEY
    const privateKey = process.env.VAPID_PRIVATE_KEY

    if (publicKey && privateKey) {
      try {
        webpush.setVapidDetails(
          process.env.VAPID_SUBJECT ?? 'mailto:hello@ghostline.app',
          publicKey,
          privateKey,
        )
        configured = true
      } catch (err) {
        console.error('[push] invalid VAPID configuration:', err)
        configured = false
      }
    } else {
      configured = false
    }
  }

  return configured
}

export function getPublicKey(): string | null {
  return isPushConfigured() ? (process.env.VAPID_PUBLIC_KEY ?? null) : null
}

/** Hard cap per user — oldest subscriptions are ignored if old data exceeds it. */
const MAX_SUBSCRIPTIONS_PER_USER = 8

type StoredPushSubscription = {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  createdAt?: unknown
}

function timestampMillis(value: unknown): number {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    const date = (value as { toDate: () => Date }).toDate()
    return date instanceof Date ? date.getTime() : 0
  }
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!isPushConfigured()) return 0

  const firestore = getFirebaseAdminFirestore()
  let subscriptions: StoredPushSubscription[]

  try {
    const snapshot = await firestore
      .collection('pushSubscriptions')
      .where('userId', '==', userId)
      .get()

    subscriptions = snapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }) as StoredPushSubscription)
      .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt))
      .slice(0, MAX_SUBSCRIPTIONS_PER_USER)
  } catch (err) {
    console.warn('[push] could not load subscriptions for user:', userId, err)
    return 0
  }

  if (subscriptions.length === 0) return 0

  let delivered = 0
  const staleIds: string[] = []

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          JSON.stringify(payload),
          { TTL: 3600 },
        )
        delivered += 1
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          staleIds.push(subscription.id)
        } else {
          console.warn(
            `[push] delivery failed (${status ?? 'network'}) endpoint=${subscription.endpoint.slice(0, 48)}…`,
          )
        }
      }
    }),
  )

  if (staleIds.length > 0) {
    try {
      const staleSnapshots = await Promise.all(
        staleIds.map((id) => firestore.collection('pushSubscriptions').doc(id).get()),
      )
      const batch = firestore.batch()
      let deleteCount = 0
      for (const snapshot of staleSnapshots) {
        // Match the previous Prisma deleteMany guard: only remove this user's
        // subscription, even if an endpoint was reassigned while sending.
        if (snapshot.exists && snapshot.data()?.userId === userId) {
          batch.delete(snapshot.ref)
          deleteCount += 1
        }
      }
      if (deleteCount > 0) await batch.commit()
    } catch {
      // A failed best-effort cleanup should not fail notification delivery.
    }
  }

  return delivered
}
