import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { avatarUrlFor } from '@/lib/dto'
import { normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }

export const GET = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const storySnap = await firestore.collection('stories').doc(id).get()
  if (!storySnap.exists || storySnap.data()?.ownerId !== auth.profile.id) throw notFound('Story not found.', 'STORY_NOT_FOUND')
  const viewsSnap = await firestore.collection('stories').doc(id).collection('views').get()
  const views = viewsSnap.docs
    .sort((a, b) => {
      const ad = a.data().viewedAt instanceof Timestamp ? a.data().viewedAt.toMillis() : 0
      const bd = b.data().viewedAt instanceof Timestamp ? b.data().viewedAt.toMillis() : 0
      return bd - ad
    })
    .slice(0, 100)
  const viewers = (await Promise.all(views.map(async (v) => {
    const [profileSnap, presenceSnap] = await Promise.all([
      firestore.collection('profiles').doc(v.id).get(),
      firestore.collection('presences').doc(v.id).get(),
    ])
    if (!profileSnap.exists) return null
    const profile = profileSnap.data()!
    const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
    const viewedAt = v.data().viewedAt instanceof Timestamp ? v.data().viewedAt.toDate() : new Date(v.data().viewedAt ?? 0)
    return {
      publicId: profile.publicId,
      displayName: profile.displayName,
      avatarUrl: avatarUrlFor(profile.avatarFileId ?? null),
      online: presence?.isOnline ?? false,
      viewedAt: viewedAt.toISOString(),
    }
  }))).filter(Boolean)
  return ok({ viewers })
})
