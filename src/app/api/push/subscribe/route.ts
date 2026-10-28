import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import {
  mirrorRelayDocument,
  deleteRelayDocument,
} from '@/lib/supabase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { isPushConfigured } from '@/lib/push'

export const dynamic = 'force-dynamic'

const endpointId = (endpoint: string) =>
  createHash('sha256').update(endpoint).digest('hex')

async function mirrorSubscriptionBestEffort(
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await mirrorRelayDocument('pushSubscriptions', id, data)
  } catch (err) {
    console.warn('[push] Supabase subscription backup failed:', err)
  }
}

async function deleteRelayBestEffort(id: string): Promise<void> {
  try {
    await deleteRelayDocument('pushSubscriptions', id)
  } catch (err) {
    console.warn('[push] Supabase subscription cleanup failed:', err)
  }
}

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  if (
    !rateLimit(
      `push-sub:${auth.profile.id}`,
      LIMITS.general.limit,
      LIMITS.general.windowMs,
    )
  ) {
    throw tooMany('Too many requests. Try again shortly.', 60)
  }

  if (!isPushConfigured()) {
    throw badRequest(
      'Push notifications are not available on this server.',
      'PUSH_DISABLED',
    )
  }

  const body = await req.json().catch(() => null)
  const endpoint =
    typeof body?.endpoint === 'string' ? body.endpoint.slice(0, 1024) : ''
  const p256dh =
    typeof body?.keys?.p256dh === 'string'
      ? body.keys.p256dh.slice(0, 256)
      : ''
  const authSecret =
    typeof body?.keys?.auth === 'string'
      ? body.keys.auth.slice(0, 256)
      : ''
  const userAgent =
    typeof body?.userAgent === 'string'
      ? body.userAgent.slice(0, 256)
      : null

  if (!endpoint.startsWith('https://') || !p256dh || !authSecret) {
    throw badRequest(
      'Invalid push subscription payload.',
      'INVALID_SUBSCRIPTION',
    )
  }

  const firestore = getFirebaseAdminFirestore()
  const collection = firestore.collection('pushSubscriptions')
  const id = endpointId(endpoint)
  const ref = collection.doc(id)
  const prior = await ref.get()

  const existing = await collection
    .where('userId', '==', auth.profile.id)
    .orderBy('createdAt', 'asc')
    .get()

  const userSubscriptions = existing.docs.filter((doc) => doc.id !== id)

  if (userSubscriptions.length >= 7) {
    const toRemove = userSubscriptions.slice(
      0,
      Math.max(0, userSubscriptions.length - 7),
    )

    for (let i = 0; i < toRemove.length; i += 400) {
      const batch = firestore.batch()
      const chunk = toRemove.slice(i, i + 400)

      chunk.forEach((doc) => batch.delete(doc.ref))
      await batch.commit()

      await Promise.allSettled(
        chunk.map((doc) => deleteRelayBestEffort(doc.id)),
      )
    }
  }

  const createdAt = prior.exists
    ? prior.data()?.createdAt ?? Timestamp.now()
    : Timestamp.now()
  const updatedAt = Timestamp.now()

  const subscriptionData = {
    userId: auth.profile.id,
    endpoint,
    p256dh,
    auth: authSecret,
    userAgent,
    createdAt,
    updatedAt,
  }

  await ref.set(subscriptionData, { merge: true })

  // Use JSON-safe timestamps in the Supabase mirror.
  await mirrorSubscriptionBestEffort(id, {
    ...subscriptionData,
    createdAt:
      typeof createdAt?.toDate === 'function'
        ? createdAt.toDate().toISOString()
        : new Date().toISOString(),
    updatedAt: updatedAt.toDate().toISOString(),
  })

  return ok({ subscribed: true, id })
})

export const DELETE = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const body = await req.json().catch(() => ({}))
  const endpoint =
    typeof body?.endpoint === 'string' ? body.endpoint.slice(0, 1024) : ''

  const firestore = getFirebaseAdminFirestore()
  const collection = firestore.collection('pushSubscriptions')
  const idsToDelete: string[] = []

  if (endpoint) {
    const id = endpointId(endpoint)
    const ref = collection.doc(id)
    const snap = await ref.get()

    if (snap.exists && snap.data()?.userId === auth.profile.id) {
      await ref.delete()
      idsToDelete.push(id)
    }
  } else {
    const rows = await collection
      .where('userId', '==', auth.profile.id)
      .get()

    for (let i = 0; i < rows.docs.length; i += 400) {
      const batch = firestore.batch()
      const chunk = rows.docs.slice(i, i + 400)

      chunk.forEach((doc) => {
        batch.delete(doc.ref)
        idsToDelete.push(doc.id)
      })

      await batch.commit()
    }
  }

  await Promise.allSettled(
    idsToDelete.map((id) => deleteRelayBestEffort(id)),
  )

  return ok({ unsubscribed: true })
})
