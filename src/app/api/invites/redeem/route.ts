import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { createDirectConversation } from '@/lib/conversation-create'
import { isExpirationPolicy } from '@/lib/expire'
import { toConversationSummary, type ContactFlags } from '@/lib/dto'
import { normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`redeem:${auth.profile.id}`, LIMITS.inviteRedeem.limit, LIMITS.inviteRedeem.windowMs)) throw tooMany('Too many invite attempts. Try again later.', 1800)
  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(String(body?.code ?? ''))
  if (!isValidCodeShape(code, 7, 8)) throw badRequest('Invite codes look like XK7Q2M9P (7–8 characters).', 'INVALID_INVITE')
  const policy = isExpirationPolicy(body?.expirationPolicy) ? body.expirationPolicy : '24h'
  const candidates = code.length === 8 ? [`${code.slice(0, 4)}-${code.slice(4)}`, code] : [code]
  const firestore = getFirebaseAdminFirestore()
  const recipientSnap = await firestore.collection('profiles').where('inviteCode', 'in', candidates).limit(1).get()
  if (recipientSnap.empty) throw notFound('This invite code is not valid anymore.', 'INVITE_NOT_FOUND')
  const recipient = recipientSnap.docs[0]
  if (recipient.id === auth.profile.id) throw badRequest('That is your own invite code.', 'SELF_INVITE')
  let conversation: any
  try {
    conversation = await createDirectConversation(auth.profile.id, recipient.id, policy)
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'BLOCKED') throw forbidden('This invite cannot be used right now.', 'INVITE_UNAVAILABLE')
    throw err
  }
  await publishFirebaseUserEvent([recipient.id, auth.profile.id], 'conversation:new', { conversationId: conversation.id, byPublicId: auth.profile.publicId })

  const convRef = firestore.collection('conversations').doc(conversation.id)
  const [convSnap, participantSnap, contactsSnap] = await Promise.all([
    convRef.get(), convRef.collection('participants').get(), firestore.collection('contacts').where('ownerId', '==', auth.profile.id).get(),
  ])
  if (!convSnap.exists) throw badRequest('Could not open the conversation.', 'CONVERSATION_LOST')
  const participants = await Promise.all(participantSnap.docs.map(async (p) => {
    const [profileSnap, presenceSnap] = await Promise.all([
      firestore.collection('profiles').doc(p.id).get(), firestore.collection('presences').doc(p.id).get(),
    ])
    const data = p.data()
    const profile = profileSnap.exists ? normalizeFirestoreValue(profileSnap.data()) : { id: p.id, displayName: 'Anonymous' }
    const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
    return { ...normalizeFirestoreValue(data), userId: p.id, user: { id: p.id, ...profile, presence } }
  }))
  const presenceByUser = new Map(participants.map((p: any) => [p.userId, p.user?.presence ?? null]))
  const contacts: ContactFlags = new Map(contactsSnap.docs.map((d) => {
    const c = d.data(); return [c.contactId, { nickname: c.nickname ?? null, favorite: Boolean(c.favorite) }]
  }))
  const summary = await toConversationSummary(
    { id: convSnap.id, ...normalizeFirestoreValue(convSnap.data()) } as never,
    auth.profile.id,
    participants as never,
    presenceByUser,
    contacts,
  )
  return ok({ conversation: summary })
})
