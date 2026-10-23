/**
 * Server-side Web Push (VAPID) helper for the Next.js API routes.
 *
 * NOTE: the realtime mini-service has its own copy of this logic (it knows
 * exactly which users have live sockets). This module is used by HTTP-only
 * paths, e.g. /api/push/test.
 */
import webpush from 'web-push'
import { db } from '@/lib/db'

export type PushPayload = {
  title: string
  body: string
  tag?: string
  /** Deep-link path opened when the notification is tapped, e.g. /?chat=<id> */
  url?: string
}

let configured: boolean | null = null

/** Configures web-push once; returns false when VAPID env is missing. */
export function isPushConfigured(): boolean {
  if (configured === null) {
    const publicKey = process.env.VAPID_PUBLIC_KEY
    const privateKey = process.env.VAPID_PRIVATE_KEY
    if (publicKey && privateKey) {
      try {
        webpush.setVapidDetails(
          process.env.VAPID_SUBJECT ?? 'mailto:hello@ghostline.app',
          publicKey,
          privateKey
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

/** Hard cap per user — oldest subscriptions are dropped beyond this. */
const MAX_SUBSCRIPTIONS_PER_USER = 8

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!isPushConfigured()) return 0
  const subs = await db.pushSubscription
    .findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })
    .catch(() => [])
  if (subs.length === 0) return 0

  let delivered = 0
  const staleIds: string[] = []

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payload),
          { TTL: 3600 }
        )
        delivered += 1
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) staleIds.push(sub.id)
        else console.warn(`[push] delivery failed (${status ?? 'network'}) endpoint=${sub.endpoint.slice(0, 48)}…`)
      }
    })
  )

  if (staleIds.length > 0) {
    await db.pushSubscription
      .deleteMany({ where: { id: { in: staleIds }, userId } })
      .catch(() => undefined)
  }
  return delivered
}
