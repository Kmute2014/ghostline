import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { notifyUsers } from '@/lib/notify'
import { unlinkByStoragePath } from '@/lib/uploads'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Leaves a group conversation. A system message marks the departure for the
 * remaining members; the last member leaving removes the group entirely.
 */
export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const meId = auth.profile.id

  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { participants: true },
  })
  if (!conversation) throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  if (conversation.type !== 'group') {
    throw badRequest('Only group chats can be left.', 'NOT_A_GROUP')
  }
  const mePart = conversation.participants.find((p) => p.userId === meId)
  if (!mePart) throw badRequest('You are not a participant of this conversation.', 'NOT_PARTICIPANT')

  await db.message.create({
    data: {
      conversationId: id,
      senderId: meId,
      type: 'system',
      text: `${auth.profile.displayName} left the group`,
    },
  })

  await db.conversationParticipant.delete({ where: { id: mePart.id } })

  const remaining = conversation.participants.filter((p) => p.userId !== meId)
  if (remaining.length === 0) {
    // Last one out — remove the group and its media.
    const messages = await db.message.findMany({ where: { conversationId: id }, select: { fileId: true } })
    await db.conversation.delete({ where: { id } })
    const fileIds = messages.map((m) => m.fileId).filter((v): v is string => Boolean(v))
    if (fileIds.length) {
      const files = await db.file.findMany({ where: { id: { in: fileIds } } })
      await db.file.deleteMany({ where: { id: { in: fileIds } } })
      for (const f of files) await unlinkByStoragePath(f.storagePath)
    }
    return ok({ left: true, deleted: true })
  }

  await notifyUsers(remaining.map((p) => p.userId), 'conversation:updated', {
    conversationId: id,
    memberLeft: auth.profile.publicId,
  })
  return ok({ left: true, deleted: false })
})
