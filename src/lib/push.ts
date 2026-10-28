/**
 * Server-side Web Push (VAPID) helper for Next.js API routes.
 * The realtime mini-service maintains its own copy of this logic.
 */
import webpush from 'web-push'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import {
  readRelayDocumentsForUser,
  deleteRelayDocument,
} from '@/lib/supabase-admin'

export type PushPayload = {
  title: string
  body: string
  tag?: string
  url?: string
}

let configured: boolean | null = null

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

const MAX_SUBSCRIPTIONS_PER_USER = 8

type StoredPushSubscription = {
  id: string
  userId: string
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

function validSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<StoredPushSubscription>
  return (
    typeof item.id === 'string' &&
    typeof item.userId === 'string' &&
    typeof item.endpoint === 'string' &&
    item.endpoint.startsWith('https://') &&
    typeof item.p256dh === 'string' &&
    typeof item.auth === 'string'
  )
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<number> {
  if (!isPushConfigured()) return 0

  let firestore: ReturnType<typeof getFirebaseAdminFirestore> | null = null
  let firestoreAvailable = false
  let subscriptions: StoredPushSubscription[] = []

  // Firestore remains the primary store.
  try {
    firestore = getFirebaseAdminFirestore()
    const snapshot = await firestore
      .collection('pushSubscriptions')
      .where('userId', '==', userId)
      .get()

    subscriptions = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }) as StoredPushSubscription)

    firestoreAvailable = true
  } catch (err) {
    console.warn(
      '[push] Firestore subscription read failed; trying Supabase relay:',
      err,
    )
  }

  // Merge mirrored subscriptions with the primary results. If Firestore
  // is unavailable, this becomes the fallback source.
  try {
    const mirrored = await readRelayDocumentsForUser(
      'pushSubscriptions',
      userId,
    )

    const byId = new Map<string, StoredPushSubscription>()

    for (const subscription of subscriptions) {
      if (validSubscription(subscription)) {
        byId.set(subscription.id, subscription)
      }
    }

    for (const row of mirrored) {
      const subscription = {
        id: row.document_id,
        ...row.data,
      }

      if (validSubscription(subscription)) {
        // Prefer Firestore's copy when both stores have the same ID.
        if (!byId.has(subscription.id)) {
          byId.set(subscription.id, subscription)
        }
      }
    }

    subscriptions = [...byId.values()]
  } catch (err) {
    console.warn('[push] Supabase subscription relay unavailable:', err)
  }

  subscriptions = subscriptions
    .filter((subscription) => subscription.userId === userId)
    .sort(
      (a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt),
    )
    .slice(0, MAX_SUBSCRIPTIONS_PER_USER)

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
    // Remove expired subscriptions from Supabase even if Firestore is down.
    await Promise.allSettled(
      staleIds.map((id) =>
        deleteRelayDocument('pushSubscriptions', id),
      ),
    )

    // Only remove Firestore records that still belong to this user.
    if (firestoreAvailable && firestore) {
      try {
        const staleSnapshots = await Promise.all(
          staleIds.map((id) =>
            firestore!.collection('pushSubscriptions').doc(id).get(),
          ),
        )

        const batch = firestore.batch()
        let deleteCount = 0

        for (const snapshot of staleSnapshots) {
          if (snapshot.exists && snapshot.data()?.userId === userId) {
            batch.delete(snapshot.ref)
            deleteCount += 1
          }
        }

        if (deleteCount > 0) await batch.commit()
      } catch {
        // Cleanup is best effort; never fail notification delivery.
      }
    }
  }

  return delivered
}
