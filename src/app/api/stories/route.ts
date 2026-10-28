import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { notifyUsers } from '@/lib/notify'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { STORY_TTL_HOURS } from '@/lib/expire'
import { toStoryDTO, avatarUrlFor } from '@/lib/dto'
import type { StoryGroup } from '@/lib/types'
import { addHours } from 'date-fns'
import { blockedIdsFor, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const meId = auth.profile.id
  const now = Timestamp.now()
  const [whoSavedMe, storySnapshot, blockedIds] = await Promise.all([
    firestore.collection('contacts').where('contactId', '==', meId).get(),
    firestore.collection('stories').where('status', '==', 'active').orderBy('createdAt', 'desc').limit(600).get(),
    blockedIdsFor(firestore, meId),
  ])
  const friendIds = new Set(whoSavedMe.docs.map((d) => String(d.data().ownerId)).filter(Boolean))
  const groups = new Map<string, StoryGroup>()

  const loadStory = async (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
    const raw = normalizeFirestoreValue(doc.data())
    const ownerId = String(raw.ownerId ?? '')
    const [ownerSnap, presenceSnap, viewSnap] = await Promise.all([
      firestore.collection('profiles').doc(ownerId).get(),
      firestore.collection('presences').doc(ownerId).get(),
      doc.ref.collection('views').doc(meId).get(),
    ])
    if (!ownerSnap.exists) return null
    const ownerData = normalizeFirestoreValue(ownerSnap.data())
    const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
    return {
      story: { id: doc.id, ...raw, owner: { id: ownerId, ...ownerData, presence }, views: viewSnap.exists ? [{ viewerId: meId }] : [] },
      ownerId,
    }
  }

  const loaded = (await Promise.all(storySnapshot.docs.map(loadStory))).filter(Boolean) as any[]
  const active = loaded.filter(({ story }) => story.expiresAt instanceof Date && story.expiresAt.getTime() > Date.now())
  const ownStories = active.filter(({ ownerId }) => ownerId === meId).map((x) => x.story).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const eligible = active.filter(({ story, ownerId }) => {
    if (ownerId === meId || blockedIds.has(ownerId)) return false
    if (story.audience === 'public') return true
    return story.audience === 'friends' && friendIds.has(ownerId)
  }).map((x) => x.story)

  const push = (s: any, isOwn: boolean) => {
    const g = groups.get(s.ownerId) ?? {
      owner: {
        publicId: s.owner.publicId, displayName: s.owner.displayName,
        avatarUrl: avatarUrlFor(s.owner.avatarFileId ?? null), online: s.owner.presence?.isOnline ?? false, isOwn,
      }, stories: [] as ReturnType<typeof toStoryDTO>[], hasUnseen: false,
    }
    g.stories.push(toStoryDTO(s, s.owner.publicId, { isOwn, viewedByMe: isOwn ? true : s.views.length > 0 }))
    if (!isOwn && s.views.length === 0) g.hasUnseen = true
    groups.set(s.ownerId, g)
  }
  for (const s of ownStories) push(s, true)
  for (const s of eligible) push(s, false)
  const feed = [...groups.values()].sort((a, b) => {
    if (a.owner.isOwn !== b.owner.isOwn) return a.owner.isOwn ? -1 : 1
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1
    return 0
  })
  return ok({ groups: feed })
})

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`story:${auth.profile.id}`, LIMITS.storyCreate.limit, LIMITS.storyCreate.windowMs)) throw tooMany('You are posting stories too quickly.', 600)
  const body = await req.json().catch(() => ({}))
  const type = ['text', 'image', 'video'].includes(body?.type) ? body.type : null
  if (!type) throw badRequest('Story type must be text, image or video.', 'INVALID_TYPE')
  const audience = body?.audience === 'friends' ? 'friends' : 'public'
  const text = typeof body?.text === 'string' ? body.text.slice(0, 500).trim() : ''
  const fileId = body?.fileId ? String(body.fileId) : null
  if (type === 'text' && !text) throw badRequest('A text story needs content.', 'EMPTY_STORY')
  const firestore = getFirebaseAdminFirestore()
  if (type !== 'text') {
    if (!fileId) throw badRequest('Media is required for image/video stories.', 'MEDIA_REQUIRED')
    const fileSnap = await firestore.collection('files').doc(fileId).get()
    const file = fileSnap.data()
    if (!fileSnap.exists || file?.ownerId !== auth.profile.id) throw badRequest('Invalid media.', 'INVALID_MEDIA')
    const expectedKind = type === 'image' ? ['image'] : ['video']
    if (!expectedKind.includes(String(file.kind))) throw badRequest('Media does not match the story type.', 'INVALID_MEDIA')
  }
  const createdAt = Timestamp.now()
  const expiresAt = Timestamp.fromDate(addHours(new Date(), STORY_TTL_HOURS))
  const ref = firestore.collection('stories').doc()
  const record = { ownerId: auth.profile.id, type, text: text || null, fileId, audience, status: 'active', createdAt, expiresAt }
  await ref.set(record)
  const [recipients, blockedAsOwner, blockedByOthers] = await Promise.all([
    audience === 'friends'
      ? firestore.collection('contacts').where('contactId', '==', auth.profile.id).get()
      : firestore.collection('profiles').get(),
    firestore.collection('blockedUsers').where('blockerId', '==', auth.profile.id).get(),
    firestore.collection('blockedUsers').where('blockedId', '==', auth.profile.id).get(),
  ])
  const blockedIds = new Set([
    ...blockedAsOwner.docs.map((doc) => String(doc.data().blockedId ?? '')),
    ...blockedByOthers.docs.map((doc) => String(doc.data().blockerId ?? '')),
  ])
  const recipientIds = recipients.docs
    .map((doc) => audience === 'friends' ? String(doc.data().ownerId ?? '') : doc.id)
    .filter((userId) => userId && userId !== auth.profile.id && !blockedIds.has(userId))
  await notifyUsers(recipientIds, 'stories:update', { storyId: ref.id })
  const story = normalizeFirestoreValue({ id: ref.id, ...record })
  return ok({ story: toStoryDTO(story, auth.profile.publicId, { isOwn: true, viewedByMe: true }) })
})

