import { handle, ok, unauthorized, tooMany, forbidden } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { activeRandomConversationId } from '@/lib/conversation-create'
import { isConversationExpired, computeExpiresAt } from '@/lib/expire'
import { notifyUsers } from '@/lib/notify'
import type { MatchResult, MatchState } from '@/lib/types'

export const dynamic = 'force-dynamic'

/**
 * Simple in-process mutex so two simultaneous match requests cannot observe
 * each other's intermediate state (SQLite serializes writes; this closes the
 * read window). All matching flows through this single server process.
 */
const globalForMutex = globalThis as unknown as { __matchLock: Promise<unknown> | undefined }
async function withMatchLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = globalForMutex.__matchLock ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  globalForMutex.__matchLock = run
  return run
}

/**
 * Core matching routine, shared by POST (explicit start) and GET (poll-driven
 * retry so a waiting user eventually pairs with someone who became available
 * after they joined the queue).
 *
 * Rules enforced: no self-match, no duplicate active matches, no blocked
 * pairs, unavailable users are never matched, conversation created atomically
 * server-side.
 */
async function tryMatch(meId: string): Promise<MatchResult> {
  return withMatchLock(async (): Promise<MatchResult> => {
    // Already matched? Idempotent — reopen the existing match.
    const existing = await activeRandomConversationId(meId)
    if (existing) {
      return { status: 'matched', conversationId: existing } as MatchResult
    }

    const me = await db.profile.findUnique({ where: { id: meId }, include: { presence: true } })
    if (!me?.presence) throw forbidden('Presence not initialized.', 'NO_PRESENCE')

    // Eligible candidates: online, available for random chat, not blocked,
    // and not already in an active random conversation.
    const candidates = await db.profile.findMany({
      where: {
        id: { not: meId },
        randomChatAvailable: true,
        presence: { isOnline: true },
        blocksReceived: { none: { blockerId: meId } },
        blocksMade: { none: { blockedId: meId } },
      },
      include: { presence: true, conversations: { include: { conversation: true } } },
      take: 100,
    })

    const eligible = candidates.filter((c) => {
      if (!c.presence) return false
      const inActiveRandom = c.conversations.some(
        (pc) =>
          pc.conversation.type === 'random' &&
          pc.conversation.status === 'active' &&
          !isConversationExpired(pc.conversation)
      )
      return !inActiveRandom
    })

    // Prefer users actively searching, then longest-waiting
    eligible.sort((a, b) => {
      const aSearch = a.presence!.searchingSince ? 0 : 1
      const bSearch = b.presence!.searchingSince ? 0 : 1
      if (aSearch !== bSearch) return aSearch - bSearch
      return (
        (a.presence!.searchingSince?.getTime() ?? Infinity) -
        (b.presence!.searchingSince?.getTime() ?? Infinity)
      )
    })

    const partner = eligible[0]
    if (!partner) {
      await db.presence.update({
        where: { userId: meId },
        data: { searchingSince: new Date() },
      })
      return { status: 'searching' } as MatchResult
    }

    const conversation = await db.conversation.create({
      data: {
        type: 'random',
        status: 'active',
        expirationPolicy: '24h',
        expiresAt: computeExpiresAt('24h'),
        createdById: meId,
        participants: { create: [{ userId: meId }, { userId: partner.id }] },
      },
    })

    // Both leave the searching queue
    await db.presence.updateMany({
      where: { userId: { in: [meId, partner.id] } },
      data: { searchingSince: null },
    })

    await notifyUsers([meId, partner.id], 'match:found', { conversationId: conversation.id })
    return { status: 'matched', conversationId: conversation.id } as MatchResult
  })
}

/** Start (or continue) searching. */
export const POST = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`match:${auth.profile.id}`, LIMITS.matchStart.limit, LIMITS.matchStart.windowMs)) {
    throw tooMany('Slow down a little before searching again.', 30)
  }
  return ok(await tryMatch(auth.profile.id))
})

/**
 * Current matching state. While the caller is queued, the poll ALSO retries
 * matching (rate-limited more leniently) so waiting users pair up with people
 * who became available after they joined — the socket event is the fast path,
 * this is the safety net.
 */
export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const meId = auth.profile.id
  const [presence, activeId] = await Promise.all([
    db.presence.findUnique({ where: { userId: meId } }),
    activeRandomConversationId(meId),
  ])

  if (!activeId && presence?.searchingSince && rateLimit(`matchpoll:${meId}`, 15, 60_000)) {
    const result = await tryMatch(meId)
    if (result.status === 'matched') {
      return ok({ searching: false, conversationId: result.conversationId } satisfies MatchState)
    }
  }

  const state: MatchState = {
    searching: Boolean(presence?.searchingSince),
    conversationId: activeId,
  }
  return ok(state)
})

/** Cancel an ongoing search. Approved conversations are never touched. */
export const DELETE = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  await db.presence.updateMany({
    where: { userId: auth.profile.id },
    data: { searchingSince: null },
  })
  return ok({ searching: false })
})
