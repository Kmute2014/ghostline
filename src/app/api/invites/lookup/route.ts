import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { isBlockedBetween, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

export const GET = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`invite-lookup:${auth.profile.id}`, LIMITS.inviteLookup.limit, LIMITS.inviteLookup.windowMs)) {
    throw tooMany('Too many lookups. Slow down for a moment.', 60)
  }
  const firestore = getFirebaseAdminFirestore()
  const code = normalizeCode(new URL(req.url).searchParams.get('code') ?? '')

  if (code.length === 9 && code.startsWith('G')) {
    if (!isValidCodeShape(code, 9, 9)) throw badRequest('Group invite codes look like GXK72M9P.', 'INVALID_INVITE')
    const candidates = [code, `G${code.slice(1, 5)}-${code.slice(5)}`]
    const snap = await firestore.collection('conversations')
      .where('joinCode', 'in', candidates).where('type', '==', 'group').where('status', '==', 'active').limit(1).get()
    if (snap.empty || !snap.docs[0].data().name) throw notFound('No group is using this code. Check it and try again.', 'INVITE_NOT_FOUND')
    const groupDoc = snap.docs[0]
    const memberDocs = await groupDoc.ref.collection('participants').get()
    const memberIds = memberDocs.docs.map((d) => d.id)
    if (memberIds.includes(auth.profile.id)) {
      return ok({ type: 'group', group: { name: groupDoc.data().name, memberCount: memberIds.length, isMember: true } })
    }
    for (const memberId of memberIds) {
      if (await isBlockedBetween(firestore, auth.profile.id, memberId)) {
        throw notFound('This invite code is not valid anymore.', 'INVITE_NOT_FOUND')
      }
    }
    return ok({ type: 'group', group: { name: groupDoc.data().name, memberCount: memberIds.length, isMember: false } })
  }

  if (!isValidCodeShape(code, 7, 8)) throw badRequest('Invite codes look like XK7Q2M9P (7–8 characters).', 'INVALID_INVITE')
  const candidates = [code]
  if (code.length === 8) candidates.unshift(`${code.slice(0, 4)}-${code.slice(4)}`)
  const ownerSnap = await firestore.collection('profiles').where('inviteCode', 'in', candidates).limit(1).get()
  if (ownerSnap.empty) throw notFound('No one is using this code. Check it and try again.', 'INVITE_NOT_FOUND')
  const owner = ownerSnap.docs[0]
  if (owner.id === auth.profile.id) throw badRequest('That is your own invite code — share it with a friend!', 'SELF_INVITE')
  if (await isBlockedBetween(firestore, auth.profile.id, owner.id)) throw notFound('This invite code is not valid anymore.', 'INVITE_NOT_FOUND')
  const profile = normalizeFirestoreValue(owner.data())
  const presenceSnap = await firestore.collection('presences').doc(owner.id).get()
  const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
  return ok({
    type: 'user',
    profile: {
      publicId: profile.publicId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarFileId ? `/api/files/${profile.avatarFileId}` : null,
      online: presence?.isOnline ?? false,
      lastSeenAt: presence?.lastSeenAt?.toISOString?.() ?? null,
    },
  })
})
