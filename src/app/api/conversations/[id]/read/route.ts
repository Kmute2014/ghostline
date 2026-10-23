import { NextRequest } from 'next/server'
import { handle, ok, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import { db } from '@/lib/db'
import { notifyUsers } from '@/lib/notify'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** Marks the conversation read for me and informs the other participant. */
export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  const now = new Date()
  await db.conversationParticipant.update({
    where: { id: access.meParticipant.id },
    data: { lastReadAt: now },
  })
  await notifyUsers(access.others.map((o) => o.id), 'conversation:read', {
    conversationId: id,
    publicId: auth.profile.publicId,
    lastReadAt: now.toISOString(),
  })
  return ok({ lastReadAt: now.toISOString() })
})
