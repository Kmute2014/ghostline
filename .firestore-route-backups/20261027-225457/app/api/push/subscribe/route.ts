import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { isPushConfigured } from '@/lib/push'

export const dynamic = 'force-dynamic'

/**
 * Registers (or refreshes) a Web Push subscription for the signed-in user.
 * Body: { endpoint, keys: { p256dh, auth }, userAgent? }
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`push-sub:${auth.profile.id}`, LIMITS.general.limit, LIMITS.general.windowMs)) {
    throw tooMany('Too many requests. Try again shortly.', 60)
  }
  if (!isPushConfigured()) {
    throw badRequest('Push notifications are not available on this server.', 'PUSH_DISABLED')
  }

  const body = await req.json().catch(() => null)
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.slice(0, 1024) : ''
  const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh.slice(0, 256) : ''
  const authSecret = typeof body?.keys?.auth === 'string' ? body.keys.auth.slice(0, 256) : ''
  const userAgent = typeof body?.userAgent === 'string' ? body.userAgent.slice(0, 256) : null

  if (!endpoint.startsWith('https://') || !p256dh || !authSecret) {
    throw badRequest('Invalid push subscription payload.', 'INVALID_SUBSCRIPTION')
  }

  // Keep a sane cap per user: drop the oldest beyond 8 devices.
  const existing = await db.pushSubscription.findMany({
    where: { userId: auth.profile.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (existing.length >= 8) {
    const excess = existing.slice(0, existing.length - 7)
    await db.pushSubscription.deleteMany({ where: { id: { in: excess.map((s) => s.id) } } })
  }

  const sub = await db.pushSubscription.upsert({
    where: { endpoint },
    create: { userId: auth.profile.id, endpoint, p256dh, auth: authSecret, userAgent },
    update: { p256dh, auth: authSecret, userAgent, userId: auth.profile.id },
    select: { id: true },
  })

  return ok({ subscribed: true, id: sub.id })
})

/** Removes one subscription (by endpoint) or all of the user's subscriptions. */
export const DELETE = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const body = await req.json().catch(() => ({}))
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.slice(0, 1024) : ''
  if (endpoint) {
    await db.pushSubscription.deleteMany({
      where: { userId: auth.profile.id, endpoint },
    })
  } else {
    await db.pushSubscription.deleteMany({ where: { userId: auth.profile.id } })
  }
  return ok({ unsubscribed: true })
})
