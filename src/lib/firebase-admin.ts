import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

let adminApp: App | undefined

function getAdminApp(): App {
  if (adminApp) return adminApp

  const existingApp = getApps()[0]
  adminApp =
    existingApp ??
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID,
    })

  return adminApp
}

export function getFirebaseStorageBucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET
  if (!bucketName) {
    throw new Error('FIREBASE_STORAGE_BUCKET must be configured to use Firebase Storage.')
  }

  return getStorage(getAdminApp()).bucket(bucketName)
}

export function createFirebaseCustomToken(userId: string): Promise<string> {
  return getAuth(getAdminApp()).createCustomToken(userId)
}

export async function publishFirebaseUserEvent(
  userIds: string[],
  event: string,
  payload: unknown,
): Promise<void> {
  const firestore = getFirestore(getAdminApp())
  const uniqueIds = [...new Set(userIds)]

  for (let offset = 0; offset < uniqueIds.length; offset += 400) {
    const batch = firestore.batch()
    const targets = uniqueIds.slice(offset, offset + 400)
    for (const userId of targets) {
      const eventRef = firestore.collection('realtimeUsers').doc(userId).collection('events').doc()
      batch.create(eventRef, {
        event,
        payload,
        createdAt: FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
    }
    await batch.commit()
  }
}

export async function publishFirebaseBroadcastEvent(
  room: string,
  event: string,
  payload: unknown,
): Promise<void> {
  if (room !== 'feed') {
    throw new Error(`Unsupported public Firebase realtime room: ${room}`)
  }

  await getFirestore(getAdminApp()).collection('realtimeBroadcasts').add({
    room,
    event,
    payload,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  })
}
