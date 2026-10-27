import { NextRequest, NextResponse } from 'next/server'
import { handle, ok, unauthorized, tooMany } from '@/lib/api-helpers'
import { getAuth, clearSessionCookie } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { unlinkByStoragePath } from '@/lib/uploads'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

/**
 * Deletes the anonymous identity and its associated data:
 * profile, sessions, presence, location, stories (+media), contacts,
 * blocks, reports, sent messages and 1:1 conversations (with media).
 * The other side of each conversation is notified in realtime.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`delete:${auth.profile.id}`, LIMITS.accountDelete.limit, LIMITS.accountDelete.windowMs)) {
    throw tooMany('Too many deletion attempts. Contact support if this persists.', 3600)
  }
  // Confirm via body flag (double-submit pattern keeps destructive action deliberate)
  const body = await req.json().catch(() => ({}))
  if (body?.confirm !== 'DELETE') {
    return ok({ requiresConfirmation: true, message: 'Send { confirm: "DELETE" } to erase this identity permanently.' })
  }

  const meId = auth.profile.id

  // Collect data before deletion
  const [participations, myStories, myFiles] = await Promise.all([
    db.conversationParticipant.findMany({
      where: { userId: meId },
      include: { conversation: { include: { participants: true } } },
    }),
    db.story.findMany({ where: { ownerId: meId } }),
    db.file.findMany({ where: { ownerId: meId } }),
  ])

  const partnerIds = new Set<string>()
  const conversationIds = new Set<string>()
  for (const p of participations) {
    conversationIds.add(p.conversationId)
    for (const q of p.conversation.participants) {
      if (q.userId !== meId) partnerIds.add(q.userId)
    }
  }

  // Notify partners before rows disappear
  await notifyUsers([...partnerIds], 'conversation:deleted', {
    conversationIds: [...conversationIds],
    reason: 'account_deleted',
  })

  await db.$transaction(async (tx) => {
    // Messages in conversations I took part in (1:1 chats die with the account)
    for (const convId of conversationIds) {
      await tx.message.deleteMany({ where: { conversationId: convId } })
      await tx.conversationParticipant.deleteMany({ where: { conversationId: convId } })
      await tx.conversation.delete({ where: { id: convId } })
    }
    for (const s of myStories) {
      await tx.storyView.deleteMany({ where: { storyId: s.id } })
    }
    await tx.story.deleteMany({ where: { ownerId: meId } })
    await tx.contact.deleteMany({ where: { OR: [{ ownerId: meId }, { contactId: meId }] } })
    await tx.blockedUser.deleteMany({ where: { OR: [{ blockerId: meId }, { blockedId: meId }] } })
    await tx.abuseReport.deleteMany({ where: { OR: [{ reporterId: meId }, { reportedUserId: meId }] } })
    await tx.session.deleteMany({ where: { userId: meId } })
    await tx.presence.deleteMany({ where: { userId: meId } })
    await tx.location.deleteMany({ where: { userId: meId } })
    await tx.profile.delete({ where: { id: meId } }) // cascades: files, sessions, presence…
  })

  // Bytes cleanup (rows cascade-deleted; unlink the storage directly).
  // myFiles covers avatars, message media and story media (all owned by the user).
  for (const f of myFiles) await unlinkByStoragePath(f.storagePath)

  const res = NextResponse.json({ deleted: true })
  return clearSessionCookie(res)
})
