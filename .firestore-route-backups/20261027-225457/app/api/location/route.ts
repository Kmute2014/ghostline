import { NextRequest } from 'next/server'
import { handle, ok, badRequest, forbidden, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { MAX_RADIUS_M } from '@/lib/geo'

export const dynamic = 'force-dynamic'

/**
 * Stores coordinates ONLY when nearby discovery is enabled. Coordinates are
 * protected: they are never returned to any client — nearby results expose a
 * rounded distance label computed server-side.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`loc:${auth.profile.id}`, 30, 60_000)) {
    throw badRequest('Location updates are too frequent.', 'RATE_LIMITED')
  }

  const profile = await db.profile.findUnique({ where: { id: auth.profile.id } })
  if (!profile?.nearbyVisible) {
    throw forbidden('Enable nearby visibility before sharing location.', 'DISCOVERY_DISABLED')
  }

  const body = await req.json().catch(() => ({}))
  const lat = Number(body?.lat)
  const lng = Number(body?.lng)
  const accuracy = body?.accuracy !== undefined && body?.accuracy !== null ? Number(body.accuracy) : null
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw badRequest('Invalid coordinates.', 'INVALID_COORDS')
  }
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_RADIUS_M * 4)) {
    throw badRequest('Invalid accuracy value.', 'INVALID_COORDS')
  }

  const location = await db.location.upsert({
    where: { userId: auth.profile.id },
    create: { userId: auth.profile.id, lat, lng, accuracy },
    update: { lat, lng, accuracy },
  })

  return ok({ locationUpdatedAt: location.updatedAt.toISOString(), shared: true })
})

/** Opting out deletes stored coordinates immediately. */
export const DELETE = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  await db.$transaction([
    db.location.deleteMany({ where: { userId: auth.profile.id } }),
    db.profile.update({ where: { id: auth.profile.id }, data: { nearbyVisible: false } }),
  ])
  return ok({ shared: false, nearbyVisible: false })
})
