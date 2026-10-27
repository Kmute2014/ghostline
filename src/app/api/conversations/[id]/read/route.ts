
import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import {
  handle,
  ok,
  unauthorized,
} from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getConversationAccess } from '@/lib/conversation-access'
import {
  getFirebaseAdminFirestore,
  publishFirebaseUserEvent,
} from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

/** Marks the conversation read for me and informs the other participants. */
export const POST = handle(async (_req: NextRequest, ctx: Ctx) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const { id } = await ctx.params
  const access = await getConversationAccess(id, auth.profile.id)

  const now = new Date()
  const firestore = getFirebaseAdminFirestore()

  const participantRef = firestore
    .collection('conversations')
    .doc(access.conversation.id)
    .collection('participants')
    .doc(auth.profile.id)

  await participantRef.update({
    lastReadAt: Timestamp.fromDate(now),
  })

  await publishFirebaseUserEvent(
    access.others.map((other) => other.id),
    'conversation:read',
    {
      conversationId: id,
      publicId: auth.profile.publicId,
      lastReadAt: now.toISOString(),
    },
  )

  return ok({ lastReadAt: now.toISOString() })
})
