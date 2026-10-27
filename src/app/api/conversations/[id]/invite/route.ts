
import { NextRequest } from 'next/server'
import {
  handle,
  ok,
  unauthorized,
  badRequest,
  tooMany,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { generateGroupJoinCode } from '@/lib/ids'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Returns a group's shareable join code, creating it lazily if needed.
 * Body: { rotate: true } invalidates the previous code and creates a new one.
 * Only group participants can access this endpoint.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const firestore = getFirebaseAdminFirestore()
  const conversationRef = firestore.collection('conversations').doc(id)

  const [conversationSnapshot, participantSnapshot] = await Promise.all([
    conversationRef.get(),
    conversationRef
      .collection('participants')
      .doc(auth.profile.id)
      .get(),
  ])

  if (!conversationSnapshot.exists) {
    throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  }

  const conversation = conversationSnapshot.data()!

  if (conversation.status !== 'active') {
    throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
  }

  if (conversation.type !== 'group') {
    throw badRequest(
      'Only group chats have invite codes.',
      'NOT_A_GROUP',
    )
  }

  if (!participantSnapshot.exists) {
    throw badRequest(
      'You are not a participant of this group.',
      'NOT_PARTICIPANT',
    )
  }

  const body = await req.json().catch(() => ({}))
  const rotate = body?.rotate === true

  let joinCode =
    typeof conversation.joinCode === 'string'
      ? conversation.joinCode
      : null

  if (!joinCode || rotate) {
    if (
      rotate &&
      !rateLimit(
        `invite-rotate:${auth.profile.id}`,
        LIMITS.inviteRotate.limit,
        LIMITS.inviteRotate.windowMs,
      )
    ) {
      throw tooMany('Too many code refreshes. Try again later.', 1800)
    }

    let saved = false

    // Retry if a generated code collides with an existing group code.
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateGroupJoinCode()

      const existing = await firestore
        .collection('conversations')
        .where('joinCode', '==', candidate)
        .limit(1)
        .get()

      if (!existing.empty && existing.docs[0].id !== id) {
        continue
      }

      try {
        await firestore.runTransaction(async (transaction) => {
          const latestSnapshot = await transaction.get(conversationRef)

          if (!latestSnapshot.exists) {
            throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
          }

          const latest = latestSnapshot.data()!

          if (
            latest.type !== 'group' ||
            latest.status !== 'active'
          ) {
            throw badRequest('Group not found.', 'GROUP_NOT_FOUND')
          }

          const latestParticipant = await transaction.get(
            conversationRef
              .collection('participants')
              .doc(auth.profile.id),
          )

          if (!latestParticipant.exists) {
            throw badRequest(
              'You are not a participant of this group.',
              'NOT_PARTICIPANT',
            )
          }

          // Avoid overwriting a code another request created while this
          // request was checking for an existing code.
          if (!rotate && latest.joinCode) {
            joinCode = String(latest.joinCode)
            return
          }

          transaction.update(conversationRef, {
            joinCode: candidate,
          })

          joinCode = candidate
        })

        saved = true
        break
      } catch (error) {
        if (attempt === 4) throw error
      }

      if (joinCode) {
        saved = true
        break
      }
    }

    if (!saved || !joinCode) {
      throw badRequest(
        'Could not create an invitation code. Please try again.',
        'INVITE_CODE_CREATE_FAILED',
      )
    }
  }

  return ok({
    joinCode,
    shareUrl: `${new URL(req.url).origin}/?invite=${encodeURIComponent(joinCode)}`,
    rotated: rotate,
  })
})
