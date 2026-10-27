import { NextRequest, NextResponse } from 'next/server'
import { handle, ok, unauthorized, tooMany } from '@/lib/api-helpers'
import { getAuth, clearSessionCookie } from '@/lib/session'
import { getFirebaseAdminFirestore, publishFirebaseUserEvent } from '@/lib/firebase-admin'
import { rateLimit, LIMITS } from '@/lib/rate-limit'
import { Timestamp } from 'firebase-admin/firestore'
import { deleteQueryInBatches } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`delete:${auth.profile.id}`, LIMITS.accountDelete.limit, LIMITS.accountDelete.windowMs)) {
    throw tooMany('Too many deletion attempts. Contact support if this persists.', 3600)
  }
  const body = await req.json().catch(() => ({}))
  if (body?.confirm !== 'DELETE') return ok({ requiresConfirmation: true, message: 'Send { confirm: "DELETE" } to erase this identity permanently.' })

  const firestore = getFirebaseAdminFirestore()
  const meId = auth.profile.id
  const myProfileRef = firestore.collection('profiles').doc(meId)

  // Capture conversations and participants before deleting the identity.
  const participations = await firestore.collectionGroup('participants').where('userId', '==', meId).get()
  const conversationIds = [...new Set(participations.docs.map((p) => p.ref.parent.parent?.id).filter(Boolean) as string[])]
  const partnerIds = new Set<string>()
  const conversationRefs = conversationIds.map((id) => firestore.collection('conversations').doc(id))
  for (const convRef of conversationRefs) {
    const participants = await convRef.collection('participants').get()
    for (const participant of participants.docs) if (participant.id !== meId) partnerIds.add(participant.id)
  }
  if (partnerIds.size) {
    await publishFirebaseUserEvent([...partnerIds], 'conversation:deleted', { conversationIds, reason: 'account_deleted' })
  }

  // Delete every conversation the account participated in, matching the current
  // product behavior. Child collections are removed explicitly because Firestore
  // does not cascade deletes.
  for (const convRef of conversationRefs) {
    await deleteQueryInBatches(firestore, convRef.collection('messages'))
    await deleteQueryInBatches(firestore, convRef.collection('participants'))
    await convRef.delete()
  }

  const stories = await firestore.collection('stories').where('ownerId', '==', meId).get()
  for (const story of stories.docs) {
    await deleteQueryInBatches(firestore, story.ref.collection('views'))
    await story.ref.delete()
  }

  // Remove authored posts and all nested material.
  const ownPosts = await firestore.collection('posts').where('authorId', '==', meId).get()
  for (const post of ownPosts.docs) {
    await deleteQueryInBatches(firestore, post.ref.collection('comments'))
    await deleteQueryInBatches(firestore, post.ref.collection('votes'))
    await post.ref.delete()
  }
  // Remove the user's comments and votes on posts owned by other people.
  const [ownComments, ownVotes] = await Promise.all([
    firestore.collectionGroup('comments').where('authorId', '==', meId).get(),
    firestore.collectionGroup('votes').where('userId', '==', meId).get(),
  ])
  for (const group of [ownComments, ownVotes]) {
    for (let i = 0; i < group.docs.length; i += 400) {
      const batch = firestore.batch()
      group.docs.slice(i, i + 400).forEach((doc) => batch.delete(doc.ref))
      await batch.commit()
    }
  }

  const queries = [
    firestore.collection('contacts').where('ownerId', '==', meId),
    firestore.collection('contacts').where('contactId', '==', meId),
    firestore.collection('blockedUsers').where('blockerId', '==', meId),
    firestore.collection('blockedUsers').where('blockedId', '==', meId),
    firestore.collection('abuseReports').where('reporterId', '==', meId),
    firestore.collection('abuseReports').where('reportedUserId', '==', meId),
    firestore.collection('sessions').where('userId', '==', meId),
    firestore.collection('pushSubscriptions').where('userId', '==', meId),
    firestore.collection('files').where('ownerId', '==', meId),
  ]
  for (const query of queries) await deleteQueryInBatches(firestore, query)
  await Promise.all([
    firestore.collection('presences').doc(meId).delete(),
    firestore.collection('locations').doc(meId).delete(),
  ])
  await myProfileRef.delete()

  const response = NextResponse.json({ deleted: true })
  return clearSessionCookie(response)
})
