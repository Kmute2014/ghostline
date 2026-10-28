import {
  getFirebaseAdminFirestore,
  publishFirebaseBroadcastEvent,
  publishFirebaseUserEvent,
} from '@/lib/firebase-admin'
import { blockedIdsFor } from '@/lib/firestore-route-helpers'
import { sendPushToUser, type PushPayload } from '@/lib/push'

export type NotificationPreference =
  | 'notifyOnChat'
  | 'notifyWhenPeopleOnline'
  | 'notifyOnBuzz'
  | 'notifyOnStories'

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object'
    ? value as Record<string, any>
    : {}
}

function pushPayloadFor(event: string, value: unknown): PushPayload | null {
  const p = asRecord(value)

  if (event === 'message:new') {
    const sender = asRecord(p.sender)
    const type = String(p.type ?? 'text')
    const text = String(p.text ?? '').trim()

    let body = text || 'You have a new message'
    if (type === 'image') body = 'Sent you a photo'
    else if (type === 'video') body = 'Sent you a video'
    else if (type === 'audio') body = 'Sent you an audio message'
    else if (type === 'file') body = 'Sent you a file'
    else if (type !== 'text' && !text) body = 'Sent you a message'

    return {
      title: String(sender.displayName ?? sender.nickname ?? 'New message'),
      body: body.slice(0, 180),
      tag: `message-${String(p.conversationId ?? p.id ?? 'new')}`,
      url: '/',
    }
  }

  if (event === 'stories:update') {
    return {
      title: String(p.title ?? 'New story'),
      body: String(p.body ?? 'Someone shared a new story'),
      tag: `story-${String(p.storyId ?? 'new')}`,
      url: typeof p.url === 'string' ? p.url : '/?tab=stories',
    }
  }

  if (event === 'buzz:notification') {
    return {
      title: String(p.title ?? 'New Buzz activity'),
      body: String(p.body ?? p.text ?? 'There is new activity on Buzz'),
      tag: String(p.tag ?? 'buzz'),
      url: typeof p.url === 'string' ? p.url : '/',
    }
  }

  return null
}

export async function notifyPeopleOnline(
  userId: string,
  publicId: string,
  displayName: string,
): Promise<void> {
  const firestore = getFirebaseAdminFirestore()
  const [personSnap, profilesSnap, contactsSnap, blockedIds] = await Promise.all([
    firestore.collection('profiles').doc(userId).get(),
    firestore.collection('profiles').get(),
    firestore.collection('contacts').where('contactId', '==', userId).get(),
    blockedIdsFor(firestore, userId),
  ])
  if (!personSnap.exists || personSnap.data()?.showInPeople === false) return

  const savedBy = new Set(contactsSnap.docs.map((doc) => String(doc.data().ownerId ?? '')).filter(Boolean))
  const recipients = profilesSnap.docs.filter((doc) => {
    if (doc.id === userId || blockedIds.has(doc.id)) return false
    const profile = doc.data()
    if (profile.notifyWhenPeopleOnline === false) return false
    const audience = String(profile.onlineNotificationAudience ?? 'anyone')
    return audience === 'anyone' || (audience === 'friends' && savedBy.has(doc.id))
  })

  const nowIso = new Date().toISOString()
  const tasks: Promise<unknown>[] = [
    publishFirebaseUserEvent(recipients.map((recipient) => recipient.id), 'presence:update', {
      publicId,
      online: true,
      lastSeenAt: nowIso,
    }),
  ]

  tasks.push(
    ...recipients.map((recipient) =>
      sendPushToUser(recipient.id, {
        title: 'Someone is online',
        body: `${displayName} is now online.`,
        tag: `online-${publicId}`,
        url: '/?tab=people',
      }),
    ),
  )

  const results = await Promise.allSettled(tasks)
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length) {
    console.error(`[push] ${failed.length} recipient(s) failed for people-online notification`)
  }
}

export async function filterNotificationRecipients(
  userIds: string[],
  preference: NotificationPreference,
): Promise<string[]> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))]
  if (!uniqueIds.length) return []

  const firestore = getFirebaseAdminFirestore()
  const allowed: string[] = []

  for (let i = 0; i < uniqueIds.length; i += 30) {
    const batch = uniqueIds.slice(i, i + 30)
    const snapshots = await Promise.all(
      batch.map((id) => firestore.collection('profiles').doc(id).get()),
    )

    snapshots.forEach((snapshot, index) => {
      if (!snapshot.exists || snapshot.data()?.[preference] !== false) {
        allowed.push(batch[index])
      }
    })
  }

  return allowed
}

export async function notifyUsers(
  userIds: string[],
  event: string,
  payload: unknown,
): Promise<void> {
  if (!userIds.length) return

  const preferenceByEvent: Partial<Record<string, NotificationPreference>> = {
    'message:new': 'notifyOnChat',
    'stories:update': 'notifyOnStories',
    'buzz:notification': 'notifyOnBuzz',
  }

  const preference = preferenceByEvent[event]
  const recipients = preference
    ? await filterNotificationRecipients(userIds, preference)
    : [...new Set(userIds.filter(Boolean))]

  if (!recipients.length) return

  const tasks: Promise<unknown>[] = [
    publishFirebaseUserEvent(recipients, event, payload),
  ]

  const pushPayload = pushPayloadFor(event, payload)
  if (pushPayload) {
    tasks.push(
      Promise.allSettled(
        recipients.map(async (userId) => {
          await sendPushToUser(userId, pushPayload)
        }),
      ).then((results) => {
        const failed = results.filter((result) => result.status === 'rejected')
        if (failed.length) {
          console.error(`[push] ${failed.length} recipient(s) failed for ${event}`)
        }
      }),
    )
  }

  const results = await Promise.allSettled(tasks)
  if (results[0].status === 'rejected') {
    console.error(`[notify] Firebase user event failed (${event}):`, results[0].reason)
  }
}

export async function notifyRoom(
  room: string,
  event: string,
  payload: unknown,
): Promise<void> {
  try {
    await publishFirebaseBroadcastEvent(room, event, payload)
  } catch (error) {
    console.error(`[notify] Firebase broadcast failed (${event}):`, error)
  }
}
