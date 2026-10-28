import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

export const POST = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const userId = auth.profile.id
  const firestore = getFirebaseAdminFirestore()
  const presenceRef = firestore.collection('presences').doc(userId)
  const now = Timestamp.now()

  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(presenceRef)
    const existing = current.data() ?? {}
    const lastSeenAt = existing.isOnline === true && existing.lastSeenAt
      ? existing.lastSeenAt
      : now

    transaction.set(presenceRef, {
      userId,
      isOnline: true,
      lastHeartbeatAt: now,
      lastSeenAt,
    }, { merge: true })
  })

  return ok({ online: true, lastHeartbeatAt: now.toDate().toISOString() })
})
