import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { avatarUrlFor } from '@/lib/dto'
import type { BlockDTO } from '@/lib/types'
import { isBlockedBetween } from '@/lib/firestore-route-helpers'
import { Timestamp } from 'firebase-admin/firestore'

export const dynamic = 'force-dynamic'

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const rows = await firestore.collection('blockedUsers')
    .where('blockerId', '==', auth.profile.id).get()
  const blocks: BlockDTO[] = await Promise.all(rows.docs.map(async (doc) => {
    const row = doc.data()
    const targetSnap = await firestore.collection('profiles').doc(String(row.blockedId)).get()
    const target = targetSnap.data()
    if (!target) return null
    return {
      publicId: String(target.publicId),
      displayName: String(target.displayName ?? 'Anonymous'),
      avatarUrl: avatarUrlFor(target.avatarFileId ?? null),
      blockedAt: (row.createdAt instanceof Timestamp ? row.createdAt.toDate() : new Date(row.createdAt ?? 0)).toISOString(),
    }
  })).then((rows) => rows.filter(Boolean) as BlockDTO[])
  blocks.sort((a, b) => b.blockedAt.localeCompare(a.blockedAt))
  return ok({ blocks })
})

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const body = await req.json().catch(() => ({}))
  const publicId = String(body?.publicId ?? '').trim()
  if (!publicId) throw badRequest('A user is required.', 'MISSING_USER')
  const firestore = getFirebaseAdminFirestore()
  const targetSnapshot = await firestore.collection('profiles').where('publicId', '==', publicId).limit(1).get()
  if (targetSnapshot.empty) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  const target = targetSnapshot.docs[0]
  if (target.id === auth.profile.id) throw badRequest('You cannot block yourself.', 'SELF_BLOCK')
  const blockId = `${auth.profile.id}_${target.id}`
  const blockRef = firestore.collection('blockedUsers').doc(blockId)
  await blockRef.set({ blockerId: auth.profile.id, blockedId: target.id, createdAt: Timestamp.now() }, { merge: true })
  return ok({ blocked: true, publicId })
})
