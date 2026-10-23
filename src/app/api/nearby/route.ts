import { NextRequest } from 'next/server'
import { handle, ok, badRequest, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { haversineMeters, boundingBox, approximateDistance, MAX_RADIUS_M } from '@/lib/geo'
import type { NearbyUser } from '@/lib/types'
import { avatarUrlFor } from '@/lib/dto'

export const dynamic = 'force-dynamic'

/** Coordinates are treated as live for this long, then excluded from discovery. */
export const LOCATION_FRESHNESS_MS = 15 * 60_000

/**
 * Nearby people: users who explicitly opted into discovery (nearbyVisible),
 * are currently online (server-side presence), hold fresh coordinates and are
 * not blocked (either direction). Exact coordinates never leave the server —
 * only a rounded distance label.
 */
export const GET = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const url = new URL(req.url)
  const radiusRaw = Number(url.searchParams.get('radius') ?? '1000')
  if (!Number.isFinite(radiusRaw) || radiusRaw < 5 || radiusRaw > MAX_RADIUS_M) {
    throw badRequest(`Radius must be between 5 and ${MAX_RADIUS_M} metres.`, 'INVALID_RADIUS')
  }

  const me = await db.profile.findUnique({
    where: { id: auth.profile.id },
    include: { location: true },
  })
  if (!me?.nearbyVisible || !me.location) {
    return ok({ users: [], requiresLocation: true })
  }
  const myLoc = me.location
  if (Date.now() - myLoc.updatedAt.getTime() > LOCATION_FRESHNESS_MS) {
    return ok({ users: [], requiresLocation: true, stale: true })
  }

  const box = boundingBox(myLoc.lat, myLoc.lng, radiusRaw)
  const freshnessCutoff = new Date(Date.now() - LOCATION_FRESHNESS_MS)

  const candidates = await db.profile.findMany({
    where: {
      id: { not: me.id },
      nearbyVisible: true,
      location: { updatedAt: { gt: freshnessCutoff }, lat: { gte: box.minLat, lte: box.maxLat }, lng: { gte: box.minLng, lte: box.maxLng } },
      presence: { isOnline: true },
      // Neither side has blocked the other
      blocksReceived: { none: { blockerId: me.id } },
      blocksMade: { none: { blockedId: me.id } },
    },
    include: { location: true, presence: true },
    take: 200,
  })

  const users: NearbyUser[] = candidates
    .map((c) => {
      const d = haversineMeters(myLoc.lat, myLoc.lng, c.location!.lat, c.location!.lng)
      return { c, d }
    })
    .filter(({ d }) => d <= radiusRaw)
    .sort((a, b) => a.d - b.d)
    .slice(0, 50)
    .map(({ c, d }) => {
      const approx = approximateDistance(d)
      return {
        publicId: c.publicId,
        displayName: c.displayName,
        avatarUrl: avatarUrlFor(c.avatarFileId),
        online: true,
        lastSeenAt: null,
        distanceMeters: approx.meters,
        distanceLabel: approx.label,
      }
    })

  return ok({ users, requiresLocation: false })
})
