import { NextRequest } from 'next/server'
import { handle, ok, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { isConversationExpired } from '@/lib/expire'
import { avatarUrlFor } from '@/lib/dto'
import type { OnlinePerson } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** A heartbeat is considered live for this long (matches realtime service). */
const ONLINE_GRACE_MS = 75_000
const MAX_RESULTS = 200

/**
 * People directory: EVERY online user (no matching, no queue).
 *
 * Returns users who are currently online (server-side presence — heartbeat
 * fresh), chose to appear in the directory (showInPeople) and are not blocked
 * (either direction). Each entry carries an existing conversation id so the
 * client re-opens an ongoing chat instead of creating a duplicate.
 */
export const GET = handle(async (_req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id

  const freshnessCutoff = new Date(Date.now() - ONLINE_GRACE_MS)

  const candidates = await db.profile.findMany({
    where: {
      id: { not: meId },
      showInPeople: true,
      presence: { isOnline: true, lastHeartbeatAt: { gt: freshnessCutoff } },
      // Neither side has blocked the other
      blocksReceived: { none: { blockerId: meId } },
      blocksMade: { none: { blockedId: meId } },
    },
    include: { presence: true },
    orderBy: { presence: { lastHeartbeatAt: 'desc' } },
    take: MAX_RESULTS,
  })

  // Map otherUserId → most recent active conversation between us (if any)
  const participations = await db.conversationParticipant.findMany({
    where: { userId: meId },
    include: { conversation: { include: { participants: true } } },
    take: 500,
  })
  const convByOther = new Map<string, { id: string; updatedAt: Date }>()
  for (const p of participations) {
    const conv = p.conversation
    if (conv.status !== 'active' || isConversationExpired(conv)) continue
    if (conv.type !== 'direct') continue
    const other = conv.participants.find((q) => q.userId !== meId)
    if (!other) continue
    const known = convByOther.get(other.userId)
    if (!known || conv.updatedAt > known.updatedAt) {
      convByOther.set(other.userId, { id: conv.id, updatedAt: conv.updatedAt })
    }
  }

  // Favourited contacts (for the star UI)
  const favorites = await db.contact.findMany({
    where: { ownerId: meId, favorite: true },
    select: { contactId: true },
  })
  const favIds = new Set(favorites.map((f) => f.contactId))

  const users: OnlinePerson[] = candidates.map((c) => ({
    publicId: c.publicId,
    displayName: c.displayName,
    avatarUrl: avatarUrlFor(c.avatarFileId),
    online: true,
    lastSeenAt: null,
    conversationId: convByOther.get(c.id)?.id ?? null,
    favorited: favIds.has(c.id),
  }))

  return ok({ users, count: users.length })
})
