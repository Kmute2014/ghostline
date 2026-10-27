import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ publicId: string }> }

export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { publicId } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const target = await firestore.collection('profiles').where('publicId', '==', publicId).limit(1).get()
  if (target.empty) throw notFound('That user could not be found.', 'USER_NOT_FOUND')
  const matches = await firestore.collection('blockedUsers')
    .where('blockerId', '==', auth.profile.id).where('blockedId', '==', target.docs[0].id).get()
  if (!matches.empty) {
    const batch = firestore.batch()
    matches.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()
  }
  return ok({ blocked: false })
})
