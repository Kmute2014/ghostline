import { handle, ok, unauthorized, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { generateInviteCode } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/** My invite code + shareable link. */
export const GET = handle(async (req: Request) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  // Behind a gateway/proxy, req.url's origin is the internal port — prefer the
  // forwarded Host/Proto so shared links open for the recipient.
  const h = req.headers
  const proto = (h.get('x-forwarded-proto') ?? 'http').split(',')[0].trim()
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? new URL(req.url).host).split(',')[0].trim()
  const origin = `${proto}://${host}`
  return ok({
    inviteCode: auth.profile.inviteCode,
    shareUrl: `${origin}/?invite=${auth.profile.inviteCode}`,
    createdAt: auth.profile.createdAt.toISOString(),
  })
})

/** Rotates (revokes) the current invite code — old links stop working. */
export const POST = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`rotate:${auth.profile.id}`, LIMITS.inviteRotate.limit, LIMITS.inviteRotate.windowMs)) {
    throw tooMany('You can rotate your invite code a few times per hour.', 1800)
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const profile = await db.profile.update({
        where: { id: auth.profile.id },
        data: { inviteCode: generateInviteCode() },
      })
      return ok({ inviteCode: profile.inviteCode })
    } catch {
      // rare unique collision — retry with a new code
    }
  }
  throw tooMany('Could not rotate the code right now. Try again shortly.', 60)
})
