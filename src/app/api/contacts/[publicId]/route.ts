import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { isBlockedBetween } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ publicId: string }> }

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { publicId } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const hasNickname = typeof body?.nickname === 'string' && body.nickname.trim().length > 0
  const hasFavorite = typeof body?.favorite === 'boolean'
  if (!hasNickname && !hasFavorite) throw badRequest('Nothing to update — provide a nickname or a favorite flag.', 'EMPTY_UPDATE')
  const nickname = hasNickname ? String(body.nickname).trim().slice(0, 40) : undefined
  const firestore = getFirebaseAdminFirestore()
  const targetSnapshot = await firestore.collection('profiles').where('publicId', '==', publicId).limit(1).get()
  if (targetSnapshot.empty) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  const target = targetSnapshot.docs[0]
  if (await isBlockedBetween(firestore, auth.profile.id, target.id)) throw badRequest('This contact is unavailable.', 'BLOCKED')
  const ref = firestore.collection('contacts').doc(`${auth.profile.id}_${target.id}`)
  const update: Record<string, unknown> = { ownerId: auth.profile.id, contactId: target.id }
  const existing = await ref.get()
  if (!existing.exists) {
    update.createdAt = new Date()
    update.nickname = nickname ?? null
    update.favorite = hasFavorite ? body.favorite : false
  } else {
    if (nickname !== undefined) update.nickname = nickname
    if (hasFavorite) update.favorite = body.favorite
  }
  await ref.set(update, { merge: true })
  const contact = (await ref.get()).data()!
  return ok({ publicId, nickname: contact.nickname ?? null, favorite: Boolean(contact.favorite), saved: true })
})

export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { publicId } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const targetSnapshot = await firestore.collection('profiles').where('publicId', '==', publicId).limit(1).get()
  if (targetSnapshot.empty) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  const ref = firestore.collection('contacts').doc(`${auth.profile.id}_${targetSnapshot.docs[0].id}`)
  await ref.delete()
  return ok({ removed: true })
})
