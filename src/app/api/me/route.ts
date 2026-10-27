import { NextRequest } from 'next/server'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { handle, ok, badRequest, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { toOwnProfile } from '@/lib/dto'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'
const NAME_RE = /^[\p{L}\p{N} _.'-]{2,24}$/u

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const firestore = getFirebaseAdminFirestore()
  const [presenceSnap, locationSnap] = await Promise.all([
    firestore.collection('presences').doc(auth.profile.id).get(),
    firestore.collection('locations').doc(auth.profile.id).get(),
  ])
  const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
  const location = locationSnap.exists ? normalizeFirestoreValue(locationSnap.data()) : null
  return ok(toOwnProfile(normalizeFirestoreValue(auth.profile), presence, location))
})

export const PATCH = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const body = await req.json().catch(() => ({}))
  const data: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
  const firestore = getFirebaseAdminFirestore()
  const profileRef = firestore.collection('profiles').doc(auth.profile.id)

  if (body.displayName !== undefined) {
    const trimmed = String(body.displayName).trim().replace(/\s+/g, ' ')
    if (!NAME_RE.test(trimmed)) throw badRequest('Display name must be 2–24 letters, numbers or spaces.', 'INVALID_NAME')
    data.displayName = trimmed
  }

  if (body.avatarFileId !== undefined) {
    const fileId = body.avatarFileId === null ? null : String(body.avatarFileId)
    if (fileId) {
      const fileSnap = await firestore.collection('files').doc(fileId).get()
      const file = fileSnap.data()
      if (!fileSnap.exists || file?.ownerId !== auth.profile.id || file?.kind !== 'avatar') throw badRequest('Invalid avatar upload.', 'INVALID_AVATAR')
    }
    const old = auth.profile.avatarFileId
    data.avatarFileId = fileId
    // The current project has media uploads disabled; clean only stale metadata.
    if (old && old !== fileId) {
      const oldRef = firestore.collection('files').doc(String(old))
      const oldSnap = await oldRef.get()
      if (oldSnap.exists && oldSnap.data()?.ownerId === auth.profile.id) await oldRef.delete()
    }
  }

  if (body.nearbyVisible !== undefined) {
    const visible = Boolean(body.nearbyVisible)
    data.nearbyVisible = visible
    if (!visible) await firestore.collection('locations').doc(auth.profile.id).delete()
  }
  if (body.showInPeople !== undefined) data.showInPeople = Boolean(body.showInPeople)
  if (body.notifyWhenPeopleOnline !== undefined) data.notifyWhenPeopleOnline = Boolean(body.notifyWhenPeopleOnline)
  if (body.onlineNotificationAudience !== undefined) {
    if (body.onlineNotificationAudience !== 'anyone' && body.onlineNotificationAudience !== 'friends') {
      throw badRequest('Choose anyone or friends for online notifications.', 'INVALID_ONLINE_NOTIFICATION_AUDIENCE')
    }
    data.onlineNotificationAudience = body.onlineNotificationAudience
  }
  if (body.defaultStoryAudience !== undefined) data.defaultStoryAudience = body.defaultStoryAudience === 'friends' ? 'friends' : 'public'

  await profileRef.update(data)
  const profileSnap = await profileRef.get()
  if (!profileSnap.exists) throw unauthorized()
  const [presenceSnap, locationSnap] = await Promise.all([
    firestore.collection('presences').doc(auth.profile.id).get(),
    firestore.collection('locations').doc(auth.profile.id).get(),
  ])
  const profile = { id: profileSnap.id, ...normalizeFirestoreValue(profileSnap.data()) }
  const presence = presenceSnap.exists ? normalizeFirestoreValue(presenceSnap.data()) : null
  const location = locationSnap.exists ? normalizeFirestoreValue(locationSnap.data()) : null
  return ok(toOwnProfile(profile as never, presence, location))
})
