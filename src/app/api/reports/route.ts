import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const REASONS = ['harassment', 'spam', 'inappropriate_content', 'impersonation', 'underage', 'other']

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`report:${auth.profile.id}`, LIMITS.report.limit, LIMITS.report.windowMs)) {
    throw tooMany('Too many reports submitted. Our moderators will review the earlier ones.', 3600)
  }
  const body = await req.json().catch(() => ({}))
  const reason = String(body?.reason ?? '')
  if (!REASONS.includes(reason)) throw badRequest('Please pick a valid reason.', 'INVALID_REASON')

  const details = typeof body?.details === 'string' ? body.details.slice(0, 1000).trim() : null
  let reportedUserId: string | null = null
  let conversationId: string | null = null

  if (body?.publicId) {
    const target = await db.profile.findUnique({ where: { publicId: String(body.publicId) } })
    if (!target) throw badRequest('Reported user not found.', 'USER_NOT_FOUND')
    reportedUserId = target.id
  }
  if (body?.conversationId) {
    const conv = await db.conversation.findUnique({ where: { id: String(body.conversationId) } })
    if (!conv) throw badRequest('Reported conversation not found.', 'CONVERSATION_NOT_FOUND')
    const participant = await db.conversationParticipant.findFirst({
      where: { conversationId: conv.id, userId: auth.profile.id },
    })
    if (!participant) throw badRequest('You can only report conversations you take part in.', 'NOT_PARTICIPANT')
    conversationId = conv.id
  }
  if (!reportedUserId && !conversationId) {
    throw badRequest('Specify a user or a conversation to report.', 'MISSING_TARGET')
  }

  const report = await db.abuseReport.create({
    data: { reporterId: auth.profile.id, reportedUserId, conversationId, reason, details },
  })
  return ok({ reportId: report.id, message: 'Thank you. Our moderation team will review this report.' })
})
