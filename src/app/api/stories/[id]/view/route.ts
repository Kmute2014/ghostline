import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, notFound, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { isBlockedBetween } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const storyRef = firestore.collection('stories').doc(id)
  const storySnap = await storyRef.get()
  const story = storySnap.data()
  const expiresAt = story?.expiresAt instanceof Timestamp ? story.expiresAt.toDate() : new Date(story?.expiresAt ?? 0)
  if (!storySnap.exists || story?.status !== 'active' || expiresAt.getTime() <= Date.now()) throw notFound('This story is no longer available.', 'STORY_NOT_FOUND')

  if (story.ownerId !== auth.profile.id) {
    if (story.audience === 'friends') {
      const saved = await firestore.collection('contacts').where('ownerId', '==', story.ownerId).where('contactId', '==', auth.profile.id).limit(1).get()
      if (saved.empty) throw forbidden('This story is only visible to friends of its creator.', 'STORY_FORBIDDEN')
    }
    if (await isBlockedBetween(firestore, String(story.ownerId), auth.profile.id)) throw forbidden('This story is not available.', 'STORY_FORBIDDEN')
  }

  const viewRef = storyRef.collection('views').doc(auth.profile.id)
  await viewRef.set({ storyId: id, viewerId: auth.profile.id, viewedAt: Timestamp.now() }, { merge: true })
  const views = await storyRef.collection('views').get()
  return ok({ viewCount: views.size })
})
