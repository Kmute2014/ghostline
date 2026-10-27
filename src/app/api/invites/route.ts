import { handle, ok, unauthorized, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { generateInviteCode } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { Timestamp } from 'firebase-admin/firestore'
import { asDate } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

/** My invite code + shareable link. */
export const GET = handle(async (req: Request) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const h = req.headers
  const proto = (h.get('x-forwarded-proto') ?? 'http').split(',')[0].trim()
  const host = (h.get('x-forwarded-host') ?? h.get('host') ?? new URL(req.url).host).split(',')[0].trim()
  const origin = `${proto}://${host}`
  return ok({
    inviteCode: auth.profile.inviteCode,
    shareUrl: `${origin}/?invite=${auth.profile.inviteCode}`,
    createdAt: (asDate(auth.profile.createdAt) ?? new Date()).toISOString(),
  })
})

/** Rotates (revokes) the current invite code — old links stop working. */
export const POST = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`rotate:${auth.profile.id}`, LIMITS.inviteRotate.limit, LIMITS.inviteRotate.windowMs)) {
    throw tooMany('You can rotate your invite code a few times per hour.', 1800)
  }
  const firestore = getFirebaseAdminFirestore()
  const profileRef = firestore.collection('profiles').doc(auth.profile.id)
  for (let attempt = 0; attempt < 5; attempt++) {
    const inviteCode = generateInviteCode()
    const [existing, current] = await Promise.all([
      firestore.collection('profiles').where('inviteCode', '==', inviteCode).limit(1).get(),
      profileRef.get(),
    ])
    if (!current.exists) break
    if (!existing.empty && existing.docs[0].id !== auth.profile.id) continue
    await profileRef.update({ inviteCode, updatedAt: Timestamp.now() })
    return ok({ inviteCode })
  }
  throw tooMany('Could not rotate the code right now. Try again shortly.', 60)
})
