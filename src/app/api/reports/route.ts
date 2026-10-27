import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { isBlockedBetween } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
const REASONS = ['harassment', 'spam', 'inappropriate_content', 'impersonation', 'underage', 'other']

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`report:${auth.profile.id}`, LIMITS.report.limit, LIMITS.report.windowMs)) throw tooMany('Too many reports submitted. Our moderators will review the earlier ones.', 3600)
  const body = await req.json().catch(() => ({}))
  const reason = String(body?.reason ?? '')
  if (!REASONS.includes(reason)) throw badRequest('Please pick a valid reason.', 'INVALID_REASON')
  const details = typeof body?.details === 'string' ? body.details.slice(0, 1000).trim() : null
  const firestore = getFirebaseAdminFirestore()
  let reportedUserId: string | null = null
  let conversationId: string | null = null

  if (body?.publicId) {
    const target = await firestore.collection('profiles').where('publicId', '==', String(body.publicId)).limit(1).get()
    if (target.empty) throw badRequest('Reported user not found.', 'USER_NOT_FOUND')
    reportedUserId = target.docs[0].id
  }
  if (body?.postId) {
    const post = await firestore.collection('posts').doc(String(body.postId)).get()
    if (!post.exists) throw badRequest('Reported post not found.', 'POST_NOT_FOUND')
    reportedUserId = String(post.data()?.authorId ?? '') || null
  }
  if (body?.conversationId) {
    const convRef = firestore.collection('conversations').doc(String(body.conversationId))
    const conv = await convRef.get()
    if (!conv.exists) throw badRequest('Reported conversation not found.', 'CONVERSATION_NOT_FOUND')
    const participant = await convRef.collection('participants').doc(auth.profile.id).get()
    if (!participant.exists) throw badRequest('You can only report conversations you take part in.', 'NOT_PARTICIPANT')
    conversationId = conv.id
  }
  if (!reportedUserId && !conversationId) throw badRequest('Specify a user or a conversation to report.', 'MISSING_TARGET')
  const report = await firestore.collection('abuseReports').add({
    reporterId: auth.profile.id, reportedUserId, conversationId, reason, details,
    status: 'open', createdAt: Timestamp.now(), resolvedAt: null,
  })
  return ok({ reportId: report.id, message: 'Thank you. Our moderation team will review this report.' })
})
