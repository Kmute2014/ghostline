import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, gone } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { db } from '@/lib/db'
import { toMessageDTO } from '@/lib/dto'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }
const PAGE_SIZE = 30

/** Cursor-paginated history (older messages, newest last). */
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id) // authorization

  const url = new URL(req.url)
  const before = url.searchParams.get('before')
  const limitRaw = Number(url.searchParams.get('limit') ?? PAGE_SIZE)
  const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : PAGE_SIZE))

  const messages = await db.message.findMany({
    where: {
      conversationId: id,
      hiddenFor: { none: { userId: auth.profile.id } },
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      sender: { select: { publicId: true, displayName: true } },
      replyTo: {
        include: {
          sender: { select: { publicId: true, displayName: true } },
          hiddenFor: { where: { userId: auth.profile.id }, select: { userId: true } },
        },
      },
    },
  })

  const senderPublicIds = new Map(messages.map((m) => [m.senderId, m.sender.publicId]))
  const dtos = messages.reverse().map((m) =>
    toMessageDTO(
      m,
      senderPublicIds.get(m.senderId) ?? '',
      access.isGroup ? m.sender.displayName : null,
      m.replyTo
    )
  )

  // Read receipts are a two-party concept — direct chats only.
  const other = access.isGroup
    ? null
    : await db.conversationParticipant.findFirst({
        where: { conversationId: id, userId: { not: auth.profile.id } },
        select: { lastReadAt: true },
      })

  return ok({
    messages: dtos,
    hasMore: messages.length === limit,
    oldestCursor: dtos.length ? dtos[0].createdAt : null,
    otherLastReadAt: other?.lastReadAt?.toISOString() ?? null,
  })
})

/** HTTP send path (works alongside the realtime socket path; same validation). */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  if (access.conversation.status !== 'active') {
    throw gone('This conversation has ended and no longer accepts messages.', 'CONVERSATION_ENDED')
  }
  if (access.conversation.expiresAt && access.conversation.expiresAt.getTime() <= Date.now()) {
    throw gone('This conversation has expired and no longer accepts messages.', 'CONVERSATION_EXPIRED')
  }
  if (access.iBlockedThem || access.theyBlockedMe) {
    throw badRequest('Messaging is unavailable between blocked users.', 'BLOCKED')
  }

  const body = await req.json().catch(() => ({}))
  const type = ['text', 'image', 'video'].includes(body?.type) ? body.type : 'text'
  const text = typeof body?.text === 'string' ? body.text.slice(0, 2000).trim() : ''
  const fileId = body?.fileId ? String(body.fileId) : null
  const clientId = typeof body?.clientId === 'string' ? body.clientId.slice(0, 64) : null
  const replyToId = typeof body?.replyToId === 'string' ? body.replyToId : null

  if (type === 'text' && !text) throw badRequest('Message text is empty.', 'EMPTY_MESSAGE')
  const replyTo = replyToId
    ? await db.message.findFirst({
        where: {
          id: replyToId,
          conversationId: id,
          deletedForEveryoneAt: null,
          hiddenFor: { none: { userId: auth.profile.id } },
        },
        include: { sender: { select: { publicId: true, displayName: true } } },
      })
    : null
  if (replyToId && !replyTo) throw badRequest('That message cannot be replied to.', 'INVALID_REPLY')
  if (type !== 'text') {
    if (!fileId) throw badRequest('A media attachment is required.', 'MEDIA_REQUIRED')
    const file = await db.file.findUnique({ where: { id: fileId } })
    if (!file || file.ownerId !== auth.profile.id) throw badRequest('Invalid media attachment.', 'INVALID_MEDIA')
  }

  const message = await db.message.create({
    data: {
      conversationId: id,
      senderId: auth.profile.id,
      type,
      text: text || null,
      fileId,
      clientId,
      replyToId,
    },
  })
  await Promise.all([
    db.conversation.update({ where: { id }, data: { updatedAt: new Date() } }),
    db.conversationParticipant.update({
      where: { id: access.meParticipant.id },
      data: { lastReadAt: new Date() },
    }),
  ])

  // HTTP send path must also push realtime events (socket send path does this
  // itself). Keeps recipients live even when the sender's socket is down.
  const dto = toMessageDTO(
    message,
    auth.profile.publicId,
    access.isGroup ? auth.profile.displayName : null,
    replyTo ? { ...replyTo, hiddenFor: [] } : null
  )
  await notifyUsers(access.others.map((o) => o.id), 'message:new', dto)
  return ok({ message: dto })
})
