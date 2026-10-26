import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, forbidden, notFound } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { db } from '@/lib/db'
import { notifyUsers } from '@/lib/notify'
import { unlinkByStoragePath } from '@/lib/uploads'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; messageId: string }> }

export const PATCH = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id, messageId } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)
  const body = await req.json().catch(() => ({}))
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) throw badRequest('Message text is empty.', 'EMPTY_MESSAGE')
  if (text.length > 2000) throw badRequest('Messages can be up to 2000 characters.', 'MESSAGE_TOO_LONG')

  const message = await db.message.findFirst({ where: { id: messageId, conversationId: id } })
  if (!message) throw notFound('Message not found.')
  if (message.senderId !== auth.profile.id) throw forbidden('You can only edit your own messages.')
  if (message.type !== 'text' || message.deletedForEveryoneAt) {
    throw badRequest('Only an undeleted text message can be edited.', 'MESSAGE_NOT_EDITABLE')
  }

  const editedAt = new Date()
  const updated = await db.message.updateMany({
    where: {
      id: message.id,
      senderId: auth.profile.id,
      type: 'text',
      deletedForEveryoneAt: null,
    },
    data: { text, editedAt },
  })
  if (updated.count === 0) throw badRequest('This message can no longer be edited.', 'MESSAGE_NOT_EDITABLE')
  await notifyUsers(
    [auth.profile.id, ...access.others.map((other) => other.id)],
    'message:changed',
    { conversationId: id, messageId: message.id }
  )
  return ok({ messageId: message.id, text, editedAt: editedAt.toISOString() })
})

export const DELETE = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id, messageId } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)
  const body = await req.json().catch(() => ({}))
  const mode = body?.mode === 'everyone' ? 'everyone' : body?.mode === 'me' ? 'me' : null
  if (!mode) throw badRequest('Choose whether to delete the message for you or everyone.', 'INVALID_DELETE_MODE')

  const message = await db.message.findFirst({ where: { id: messageId, conversationId: id } })
  if (!message) throw notFound('Message not found.')

  if (mode === 'me') {
    await db.messageHidden.createMany({
      data: [{ messageId: message.id, userId: auth.profile.id }],
      skipDuplicates: true,
    })
    await notifyUsers([auth.profile.id], 'message:changed', { conversationId: id, messageId })
    return ok({ deleted: true })
  }

  if (message.senderId !== auth.profile.id) throw forbidden('You can only delete your own messages for everyone.')
  if (message.deletedForEveryoneAt) return ok({ deleted: true })

  const deletedAt = new Date()
  const deleted = await db.message.updateMany({
    where: { id: message.id, senderId: auth.profile.id, deletedForEveryoneAt: null },
    data: { text: null, fileId: null, deletedForEveryoneAt: deletedAt },
  })
  if (deleted.count === 0) return ok({ deleted: true })

  if (message.fileId) {
    const [otherMessage, story, file] = await Promise.all([
      db.message.findFirst({ where: { fileId: message.fileId }, select: { id: true } }),
      db.story.findFirst({ where: { fileId: message.fileId }, select: { id: true } }),
      db.file.findUnique({ where: { id: message.fileId }, select: { storagePath: true } }),
    ])
    if (!otherMessage && !story && file) {
      await db.file.delete({ where: { id: message.fileId } })
      await unlinkByStoragePath(file.storagePath)
    }
  }

  await notifyUsers(
    [auth.profile.id, ...access.others.map((other) => other.id)],
    'message:changed',
    { conversationId: id, messageId }
  )
  return ok({ deleted: true })
})
