import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { isPushConfigured } from '@/lib/push'

export const dynamic = 'force-dynamic'
const endpointId = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex')

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`push-sub:${auth.profile.id}`, LIMITS.general.limit, LIMITS.general.windowMs)) throw tooMany('Too many requests. Try again shortly.', 60)
  if (!isPushConfigured()) throw badRequest('Push notifications are not available on this server.', 'PUSH_DISABLED')
  const body = await req.json().catch(() => null)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.slice(0, 1024) : ''
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh.slice(0, 256) : ''
  const authSecret = typeof body?.keys?.auth === 'string' ? body.keys.auth.slice(0, 256) : ''
  const userAgent = typeof body?.userAgent === 'string' ? body.userAgent.slice(0, 256) : null
  if (!endpoint.startsWith('https://') || !p256dh || !authSecret) throw badRequest('Invalid push subscription payload.', 'INVALID_SUBSCRIPTION')
  const firestore = getFirebaseAdminFirestore()
  const collection = firestore.collection('pushSubscriptions')
  const id = endpointId(endpoint)
  const ref = collection.doc(id)
  const prior = await ref.get()
  const existing = await collection.where('userId', '==', auth.profile.id).orderBy('createdAt', 'asc').get()
  const userSubscriptions = existing.docs.filter((doc) => doc.id !== id)
  if (userSubscriptions.length >= 7) {
    const batch = firestore.batch()
    userSubscriptions.slice(0, Math.max(0, userSubscriptions.length - 7)).forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
  await ref.set({
    userId: auth.profile.id, endpoint, p256dh, auth: authSecret, userAgent,
    createdAt: prior.exists ? prior.data()?.createdAt ?? Timestamp.now() : Timestamp.now(),
    updatedAt: Timestamp.now(),
  }, { merge: true })
  return ok({ subscribed: true, id })
})

export const DELETE = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const body = await req.json().catch(() => ({}))
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.slice(0, 1024) : ''
  const firestore = getFirebaseAdminFirestore()
  const collection = firestore.collection('pushSubscriptions')
  if (endpoint) {
    const ref = collection.doc(endpointId(endpoint))
    const snap = await ref.get()
    if (snap.exists && snap.data()?.userId === auth.profile.id) await ref.delete()
  } else {
    const rows = await collection.where('userId', '==', auth.profile.id).get()
    for (let i = 0; i < rows.docs.length; i += 400) {
      const batch = firestore.batch()
      rows.docs.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
    }
  }
  return ok({ unsubscribed: true })
})
