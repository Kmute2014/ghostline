import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { handle, ok, badRequest, forbidden, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { rateLimit } from '@/lib/rate-limit'
import { MAX_RADIUS_M } from '@/lib/geo'

export const dynamic = 'force-dynamic'

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`loc:${auth.profile.id}`, 30, 60_000)) throw badRequest('Location updates are too frequent.', 'RATE_LIMITED')
  const firestore = getFirebaseAdminFirestore()
  const profileRef = firestore.collection('profiles').doc(auth.profile.id)
  const profile = await profileRef.get()
  if (!profile.exists || !profile.data()?.nearbyVisible) throw forbidden('Enable nearby visibility before sharing location.', 'DISCOVERY_DISABLED')
  const body = await req.json().catch(() => ({}))
  const lat = Number(body?.lat)
  const lng = Number(body?.lng)
  const accuracy = body?.accuracy !== undefined && body?.accuracy !== null ? Number(body.accuracy) : null
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Invalid coordinates.', 'INVALID_COORDS')
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_RADIUS_M * 4)) throw badRequest('Invalid accuracy value.', 'INVALID_COORDS')
  const now = Timestamp.now()
  await firestore.collection('locations').doc(auth.profile.id).set({ userId: auth.profile.id, lat, lng, accuracy, updatedAt: now }, { merge: true })
  return ok({ locationUpdatedAt: now.toDate().toISOString(), shared: true })
})

export const DELETE = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const batch = firestore.batch()
  batch.delete(firestore.collection('locations').doc(auth.profile.id))
  batch.set(firestore.collection('profiles').doc(auth.profile.id), { nearbyVisible: false, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  await batch.commit()
  return ok({ shared: false, nearbyVisible: false })
})
