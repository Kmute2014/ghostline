import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { avatarUrlFor } from '@/lib/dto'
import type { ContactDTO } from '@/lib/types'
import { isBlockedBetween, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'
import { Timestamp } from 'firebase-admin/firestore'

export const dynamic = 'force-dynamic'

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const rows = await firestore.collection('contacts').where('ownerId', '==', auth.profile.id).get()
  const contacts: ContactDTO[] = (await Promise.all(rows.docs.map(async (doc) => {
    const r = doc.data()
    const [profileSnap, presenceSnap] = await Promise.all([
      firestore.collection('profiles').doc(String(r.contactId)).get(),
      firestore.collection('presences').doc(String(r.contactId)).get(),
    ])
    if (!profileSnap.exists) return null
    const contact = profileSnap.data()!
    const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
    const createdAt = r.createdAt instanceof Timestamp ? r.createdAt.toDate() : new Date(r.createdAt ?? 0)
    return {
      publicId: String(contact.publicId),
      displayName: String(contact.displayName ?? 'Anonymous'),
      avatarUrl: avatarUrlFor(contact.avatarFileId ?? null),
      online: presence?.isOnline ?? false,
      lastSeenAt: presence?.isOnline ? null : presence?.lastSeenAt?.toISOString?.() ?? null,
      nickname: r.nickname ?? null,
      favorite: Boolean(r.favorite),
      savedAt: createdAt.toISOString(),
    }
  }))).filter(Boolean) as ContactDTO[]
  contacts.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  return ok({ contacts })
})

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`contact:${auth.profile.id}`, LIMITS.contactAdd.limit, LIMITS.contactAdd.windowMs)) {
    throw tooMany('Too many contact updates. Try later.', 600)
  }
  const body = await req.json().catch(() => ({}))
  const publicId = String(body?.publicId ?? '').trim()
  if (!publicId) throw badRequest('A user is required.', 'MISSING_USER')
  const firestore = getFirebaseAdminFirestore()
  const targetSnapshot = await firestore.collection('profiles').where('publicId', '==', publicId).limit(1).get()
  if (targetSnapshot.empty) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  const target = targetSnapshot.docs[0]
  if (target.id === auth.profile.id) throw badRequest('You cannot save yourself.', 'SELF_CONTACT')
  if (await isBlockedBetween(firestore, auth.profile.id, target.id)) throw badRequest('This contact is unavailable.', 'BLOCKED')
  const nickname = typeof body?.nickname === 'string' && body.nickname.trim() ? body.nickname.trim().slice(0, 40) : undefined
  const ref = firestore.collection('contacts').doc(`${auth.profile.id}_${target.id}`)
  const prior = await ref.get()
  const data: Record<string, unknown> = { ownerId: auth.profile.id, contactId: target.id }
  if (!prior.exists) {
    data.createdAt = Timestamp.now()
    data.favorite = false
    data.nickname = nickname ?? null
  } else if (nickname !== undefined) data.nickname = nickname
  await ref.set(data, { merge: true })
  const saved = await ref.get()
  return ok({ publicId: target.data().publicId, nickname: saved.data()?.nickname ?? null, saved: true })
})
