import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { deleteQueryInBatches } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export const DELETE = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const ref = firestore.collection('stories').doc(id)
  const story = await ref.get()
  if (!story.exists || story.data()?.ownerId !== auth.profile.id) throw notFound('Story not found.', 'STORY_NOT_FOUND')
  const fileId = story.data()?.fileId
  await deleteQueryInBatches(firestore, ref.collection('views'))
  await ref.delete()
  // Uploads are currently disabled; remove owned file metadata if present.
  if (fileId) {
    const fileRef = firestore.collection('files').doc(String(fileId))
    const fileSnap = await fileRef.get()
    if (fileSnap.exists && fileSnap.data()?.ownerId === auth.profile.id) await fileRef.delete()
  }
  return ok({ deleted: true })
})
