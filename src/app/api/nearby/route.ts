import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, badRequest, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { haversineMeters, boundingBox, approximateDistance, MAX_RADIUS_M } from '@/lib/geo'
import type { NearbyUser } from '@/lib/types'
import { avatarUrlFor } from '@/lib/dto'
import { blockedIdsFor, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
export const LOCATION_FRESHNESS_MS = 15 * 60_000

export const GET = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const url = new URL(req.url)
  const radiusRaw = Number(url.searchParams.get('radius') ?? '1000')
  if (!Number.isFinite(radiusRaw) || radiusRaw < 5 || radiusRaw > MAX_RADIUS_M) throw badRequest(`Radius must be between 5 and ${MAX_RADIUS_M} metres.`, 'INVALID_RADIUS')
  const firestore = getFirebaseAdminFirestore()
  const [profileSnap, myLocSnap] = await Promise.all([
    firestore.collection('profiles').doc(auth.profile.id).get(),
    firestore.collection('locations').doc(auth.profile.id).get(),
  ])
  const me = profileSnap.data()
  const myLoc = myLocSnap.exists ? normalizeFirestoreValue(myLocSnap.data()) : null
  if (!me?.nearbyVisible || !myLoc) return ok({ users: [], requiresLocation: true })
  if (Date.now() - new Date(myLoc.updatedAt).getTime() > LOCATION_FRESHNESS_MS) return ok({ users: [], requiresLocation: true, stale: true })

  const box = boundingBox(Number(myLoc.lat), Number(myLoc.lng), radiusRaw)
  const cutoff = Timestamp.fromDate(new Date(Date.now() - LOCATION_FRESHNESS_MS))
  const [locSnap, blockedIds] = await Promise.all([
    firestore.collection('locations').where('updatedAt', '>', cutoff).limit(1000).get(),
    blockedIdsFor(firestore, auth.profile.id),
  ])
  const candidates = locSnap.docs.filter((doc) => {
    if (doc.id === auth.profile.id || blockedIds.has(doc.id)) return false
    const d = doc.data()
    return Number(d.lat) >= box.minLat && Number(d.lat) <= box.maxLat && Number(d.lng) >= box.minLng && Number(d.lng) <= box.maxLng
  })
  const users: NearbyUser[] = []
  for (const locDoc of candidates) {
    const [profileSnap2, presenceSnap] = await Promise.all([
      firestore.collection('profiles').doc(locDoc.id).get(),
      firestore.collection('presences').doc(locDoc.id).get(),
    ])
    if (!profileSnap2.exists || !presenceSnap.exists) continue
    const p = profileSnap2.data()!
    const presence = normalizeFirestoreValue(presenceSnap.data())
    if (!p.nearbyVisible || !presence.isOnline) continue
    const loc = locDoc.data()
    const distance = haversineMeters(Number(myLoc.lat), Number(myLoc.lng), Number(loc.lat), Number(loc.lng))
    if (distance > radiusRaw) continue
    const approx = approximateDistance(distance)
    users.push({
      publicId: String(p.publicId), displayName: String(p.displayName ?? 'Anonymous'),
      avatarUrl: avatarUrlFor(p.avatarFileId ?? null), online: true, lastSeenAt: null,
      distanceMeters: approx.meters, distanceLabel: approx.label,
    })
  }
  // Approximate distances may tie; coordinates never leave this handler.
  users.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity))
  return ok({ users: users.slice(0, 50), requiresLocation: false })
})
