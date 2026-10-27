import { NextRequest } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { isConversationExpired } from '@/lib/expire'
import { avatarUrlFor } from '@/lib/dto'
import type { OnlinePerson } from '@/lib/types'
import { blockedIdsFor, normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
const ONLINE_GRACE_MS = 75_000
const MAX_RESULTS = 200

export const GET = handle(async (_req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const meId = auth.profile.id
  const cutoff = Timestamp.fromDate(new Date(Date.now() - ONLINE_GRACE_MS))
  const [presenceSnap, blockedIds, participationSnap, favoriteSnap] = await Promise.all([
    firestore.collection('presences').where('isOnline', '==', true).where('lastHeartbeatAt', '>', cutoff).orderBy('lastHeartbeatAt', 'desc').limit(MAX_RESULTS * 2).get(),
    blockedIdsFor(firestore, meId),
    firestore.collectionGroup('participants').where('userId', '==', meId).limit(500).get(),
    firestore.collection('contacts').where('ownerId', '==', meId).where('favorite', '==', true).get(),
  ])

  const convByOther = new Map<string, { id: string; updatedAt: Date }>()
  for (const part of participationSnap.docs) {
    const convRef = part.ref.parent.parent
    if (!convRef) continue
    const convSnap = await convRef.get()
    if (!convSnap.exists) continue
    const conv = normalizeFirestoreValue({ id: convSnap.id, ...convSnap.data() })
    if (conv.status !== 'active' || isConversationExpired(conv) || conv.type !== 'direct') continue
    const participants = await convRef.collection('participants').get()
    const other = participants.docs.find((d) => d.id !== meId)
    if (!other) continue
    const updatedAt = conv.updatedAt instanceof Date ? conv.updatedAt : new Date(conv.updatedAt ?? 0)
    const known = convByOther.get(other.id)
    if (!known || updatedAt > known.updatedAt) convByOther.set(other.id, { id: conv.id, updatedAt })
  }

  const favIds = new Set(favoriteSnap.docs.map((d) => String(d.data().contactId)))
  const users: OnlinePerson[] = []
  for (const presenceDoc of presenceSnap.docs) {
    const id = presenceDoc.id
    if (id === meId || blockedIds.has(id)) continue
    const profileSnap = await firestore.collection('profiles').doc(id).get()
    if (!profileSnap.exists) continue
    const profile = profileSnap.data()!
    if (profile.showInPeople !== true) continue
    users.push({
      publicId: String(profile.publicId), displayName: String(profile.displayName ?? 'Anonymous'),
      avatarUrl: avatarUrlFor(profile.avatarFileId ?? null), online: true, lastSeenAt: null,
      conversationId: convByOther.get(id)?.id ?? null, favorited: favIds.has(id),
    })
    if (users.length >= MAX_RESULTS) break
  }
  return ok({ users, count: users.length })
})
