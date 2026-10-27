import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { STORY_TTL_HOURS } from '@/lib/expire'
import { toStoryDTO, avatarUrlFor } from '@/lib/dto'
import type { StoryGroup } from '@/lib/types'
import { addHours } from 'date-fns'

export const dynamic = 'force-dynamic'

/**
 * Story feed, grouped by owner. Server-side audience enforcement:
 * - own stories: always visible
 * - public: visible to all eligible users (not blocked either way)
 * - friends: visible only to users the CREATOR saved as contacts
 * Expired stories are excluded (sweep deletes them within a minute).
 */
export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id

  const whoSavedMe = await db.contact.findMany({ where: { contactId: meId }, select: { ownerId: true } })

  const stories = await db.story.findMany({
    where: {
      status: 'active',
      expiresAt: { gt: new Date() },
      ownerId: { not: meId },
      audience: 'public', // friends-only stories are fetched separately below
      owner: {
        blocksReceived: { none: { blockerId: meId } },
        blocksMade: { none: { blockedId: meId } },
      },
    },
    include: { owner: { include: { presence: true } }, views: { where: { viewerId: meId } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })

  // Friends-only stories: creators who saved me AND are blocked-free both ways
  const friendIds = whoSavedMe.map((c) => c.ownerId).filter(Boolean)
  const friendStories = friendIds.length
    ? await db.story.findMany({
        where: {
          ownerId: { in: friendIds },
          audience: 'friends',
          status: 'active',
          expiresAt: { gt: new Date() },
        },
        include: { owner: { include: { presence: true } }, views: { where: { viewerId: meId } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    : []

  const friendOwners = await db.profile.findMany({
    where: { id: { in: friendIds } },
    select: { id: true, blocksMade: { select: { blockedId: true } }, blocksReceived: { select: { blockerId: true } } },
  })
  const friendAllowed = new Set(
    friendOwners
      .filter((o) => !o.blocksMade.some((b) => b.blockedId === meId) && !o.blocksReceived.some((b) => b.blockerId === meId))
      .map((o) => o.id)
  )

  const eligible = [
    ...stories,
    ...friendStories.filter((s) => friendAllowed.has(s.ownerId)),
  ]

  // Own stories
  const myStories = await db.story.findMany({
    where: { ownerId: meId, status: 'active', expiresAt: { gt: new Date() } },
    include: { owner: { include: { presence: true } }, views: { where: { viewerId: meId } } },
    orderBy: { createdAt: 'asc' },
  })

  const groups = new Map<string, StoryGroup>()

  const push = (
    s: (typeof eligible)[number],
    isOwn: boolean
  ) => {
    const g = groups.get(s.ownerId) ?? {
      owner: {
        publicId: s.owner.publicId,
        displayName: s.owner.displayName,
        avatarUrl: avatarUrlFor(s.owner.avatarFileId),
        online: s.owner.presence?.isOnline ?? false,
        isOwn,
      },
      stories: [],
      hasUnseen: false,
    }
    g.stories.push(
      toStoryDTO(s, s.owner.publicId, { isOwn, viewedByMe: isOwn ? true : s.views.length > 0 })
    )
    if (isOwn ? false : s.views.length === 0) g.hasUnseen = true
    groups.set(s.ownerId, g)
  }

  for (const s of myStories) push(s, true)
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
  if (!rateLimit(`story:${auth.profile.id}`, LIMITS.storyCreate.limit, LIMITS.storyCreate.windowMs)) {
    throw tooMany('You are posting stories too quickly.', 600)
  }
  const body = await req.json().catch(() => ({}))
  const type = ['text', 'image', 'video'].includes(body?.type) ? body.type : null
  if (!type) throw badRequest('Story type must be text, image or video.', 'INVALID_TYPE')

  const audience = body?.audience === 'friends' ? 'friends' : 'public'
  const text = typeof body?.text === 'string' ? body.text.slice(0, 500).trim() : ''
  const fileId = body?.fileId ? String(body.fileId) : null

  if (type === 'text' && !text) throw badRequest('A text story needs content.', 'EMPTY_STORY')
  if (type !== 'text') {
    if (!fileId) throw badRequest('Media is required for image/video stories.', 'MEDIA_REQUIRED')
    const file = await db.file.findUnique({ where: { id: fileId } })
    if (!file || file.ownerId !== auth.profile.id) throw badRequest('Invalid media.', 'INVALID_MEDIA')
    const expectedKind = type === 'image' ? ['image'] : ['video']
    if (!expectedKind.includes(file.kind)) throw badRequest('Media does not match the story type.', 'INVALID_MEDIA')
  }

  // Default 24h lifetime, enforced server-side — stories are NOT chats.
  const story = await db.story.create({
    data: {
      ownerId: auth.profile.id,
      type,
      text: text || null,
      fileId,
      audience,
      expiresAt: addHours(new Date(), STORY_TTL_HOURS),
    },
  })

  return ok({
    story: toStoryDTO(story, auth.profile.publicId, { isOwn: true, viewedByMe: true }),
  })
})
