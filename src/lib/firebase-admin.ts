
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App,
} from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import {
  FieldValue,
  getFirestore,
} from 'firebase-admin/firestore'

let adminApp: App | undefined

function getAdminApp(): App {
  if (adminApp) return adminApp

  const existingApp = getApps()[0]
  if (existingApp) {
    adminApp = existingApp
    return adminApp
  }

  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.FIREBASE_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID

  const serviceAccountValue =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ??
    (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
      ? Buffer.from(
          process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
          'base64',
        ).toString('utf8')
      : undefined)

  if (serviceAccountValue) {
    let serviceAccount

    try {
      serviceAccount = JSON.parse(serviceAccountValue)
    } catch {
      throw new Error(
        'Firebase service-account environment variable is not valid JSON.',
      )
    }

    adminApp = initializeApp({
      credential: cert(serviceAccount),
      ...(projectId ? { projectId } : {}),
    })
  } else {
    adminApp = initializeApp({
      credential: applicationDefault(),
      ...(projectId ? { projectId } : {}),
    })
  }

  return adminApp
}

export function getFirebaseAdminFirestore() {
  return getFirestore(getAdminApp())
}

export function createFirebaseCustomToken(
  userId: string,
): Promise<string> {
  return getAuth(getAdminApp()).createCustomToken(userId)
}

export async function publishFirebaseUserEvent(
  userIds: string[],
  event: string,
  payload: unknown,
): Promise<void> {
  const firestore = getFirebaseAdminFirestore()
  const uniqueIds = [...new Set(userIds)]

  for (let offset = 0; offset < uniqueIds.length; offset += 400) {
    const batch = firestore.batch()

    for (const userId of uniqueIds.slice(offset, offset + 400)) {
      const eventRef = firestore
        .collection('realtimeUsers')
        .doc(userId)
        .collection('events')
        .doc()

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

  await getFirebaseAdminFirestore()
    .collection('realtimeBroadcasts')
    .add({
      room,
      event,
      payload,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
}
