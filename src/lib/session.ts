
import { randomUUID } from 'crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import {
  FieldValue,
  Timestamp,
} from 'firebase-admin/firestore'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import {
  generateToken,
  generatePublicId,
  generateInviteCode,
  generateRecoveryCode,
} from '@/lib/ids'

export const SESSION_COOKIE = 'ghostline_session'

const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000
const SESSION_EXTEND_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000

export type ProfileRecord = {
  id: string
  publicId: string
  displayName: string
  inviteCode: string
  recoveryCode: string
  avatarFileId: string | null
  nearbyVisible: boolean
  showInPeople: boolean
  notifyWhenPeopleOnline: boolean
  onlineNotificationAudience: string
  defaultStoryAudience: string
  createdAt: Date
  updatedAt: Date
}

export type PresenceRecord = {
  userId: string
  isOnline: boolean
  lastHeartbeatAt: Date | null
  lastSeenAt: Date
}

export type LocationRecord = {
  userId: string
  lat?: number
  lng?: number
  accuracy?: number | null
  updatedAt: Date
}

export type SessionRecord = {
  id: string
  token: string
  socketToken: string
  userId: string
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
}

export type AuthContext = {
  profile: ProfileRecord
  sessionId: string
  token: string
}

function asDate(value: unknown, fallback = new Date()): Date {
  if (value instanceof Date) return value
  if (value instanceof Timestamp) return value.toDate()
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof value.toDate === 'function'
  ) {
    return value.toDate()
  }
  return fallback
}

function profileFromData(
  id: string,
  data: FirebaseFirestore.DocumentData,
): ProfileRecord {
  return {
    id,
    publicId: String(data.publicId),
    displayName: String(data.displayName),
    inviteCode: String(data.inviteCode),
    recoveryCode: String(data.recoveryCode),
    avatarFileId: data.avatarFileId ?? null,
    nearbyVisible: data.nearbyVisible ?? false,
    showInPeople: data.showInPeople ?? true,
    notifyWhenPeopleOnline: data.notifyWhenPeopleOnline ?? true,
    onlineNotificationAudience: data.onlineNotificationAudience ?? 'anyone',
    defaultStoryAudience: data.defaultStoryAudience ?? 'public',
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
  }
}

function presenceFromData(
  userId: string,
  data: FirebaseFirestore.DocumentData,
): PresenceRecord {
  return {
    userId,
    isOnline: data.isOnline ?? false,
    lastHeartbeatAt: data.lastHeartbeatAt
      ? asDate(data.lastHeartbeatAt)
      : null,
    lastSeenAt: asDate(data.lastSeenAt),
  }
}

function locationFromData(
  userId: string,
  data: FirebaseFirestore.DocumentData,
): LocationRecord {
  return {
    userId,
    lat: data.lat,
    lng: data.lng,
    accuracy: data.accuracy ?? null,
    updatedAt: asDate(data.updatedAt),
  }
}

function sessionFromData(
  token: string,
  data: FirebaseFirestore.DocumentData,
): SessionRecord {
  return {
    id: token,
    token,
    socketToken: String(data.socketToken),
    userId: String(data.userId),
    createdAt: asDate(data.createdAt),
    lastSeenAt: asDate(data.lastSeenAt),
    expiresAt: asDate(data.expiresAt),
  }
}

export async function getPresence(userId: string) {
  const snap = await getFirebaseAdminFirestore()
    .collection('presences')
    .doc(userId)
    .get()

  return snap.exists
    ? presenceFromData(userId, snap.data()!)
    : null
}

export async function getLocation(userId: string) {
  const snap = await getFirebaseAdminFirestore()
    .collection('locations')
    .doc(userId)
    .get()

  return snap.exists
    ? locationFromData(userId, snap.data()!)
    : null
}

export async function getSessionByToken(token: string) {
  const snap = await getFirebaseAdminFirestore()
    .collection('sessions')
    .doc(token)
    .get()

  if (!snap.exists) return null
  return sessionFromData(token, snap.data()!)
}

async function loadSessionByToken(token: string) {
  const firestore = getFirebaseAdminFirestore()
  const session = await getSessionByToken(token)

  if (!session) return null

  if (session.expiresAt.getTime() < Date.now()) {
    await firestore.collection('sessions').doc(token).delete()
      .catch(() => undefined)
    return null
  }

  const profileSnap = await firestore
    .collection('profiles')
    .doc(session.userId)
    .get()

  if (!profileSnap.exists) {
    await firestore.collection('sessions').doc(token).delete()
      .catch(() => undefined)
    return null
  }

  return {
    session,
    profile: profileFromData(session.userId, profileSnap.data()!),
  }
}

export async function getAuth(): Promise<AuthContext | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value

  if (!token) return null

  const loaded = await loadSessionByToken(token)
  if (!loaded) return null

  const { session, profile } = loaded
  const now = Date.now()
  const remaining = session.expiresAt.getTime() - now
  const firestore = getFirebaseAdminFirestore()

  if (remaining < SESSION_EXTEND_THRESHOLD_MS) {
    await firestore.collection('sessions').doc(token).update({
      expiresAt: Timestamp.fromMillis(now + SESSION_TTL_MS),
      lastSeenAt: FieldValue.serverTimestamp(),
    }).catch(() => undefined)
  } else if (now - session.lastSeenAt.getTime() > 10 * 60_000) {
    await firestore.collection('sessions').doc(token).update({
      lastSeenAt: FieldValue.serverTimestamp(),
    }).catch(() => undefined)
  }

  return {
    profile,
    sessionId: session.id,
    token,
  }
}

export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth()

  if (!auth) {
    const err = new Error('Authentication required') as Error & {
      status?: number
      code?: string
    }
    err.status = 401
    err.code = 'UNAUTHENTICATED'
    throw err
  }

  return auth
}

export function attachSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  })
  return res
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/',
  })
  return res
}

export async function createAnonymousIdentity(displayName: string) {
  const firestore = getFirebaseAdminFirestore()

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomUUID()
    const publicId = generatePublicId()
    const inviteCode = generateInviteCode()
    const recoveryCode = generateRecoveryCode()
    const profileRef = firestore.collection('profiles').doc(id)
    const presenceRef = firestore.collection('presences').doc(id)

    try {
      const profile = await firestore.runTransaction(async (tx) => {
        const checks = await Promise.all([
          tx.get(
            firestore.collection('profiles')
              .where('publicId', '==', publicId).limit(1),
          ),
          tx.get(
            firestore.collection('profiles')
              .where('inviteCode', '==', inviteCode).limit(1),
          ),
          tx.get(
            firestore.collection('profiles')
              .where('recoveryCode', '==', recoveryCode).limit(1),
          ),
        ])

        if (checks.some((result) => !result.empty)) {
          throw new Error('IDENTITY_CODE_COLLISION')
        }

        const now = Timestamp.now()

        const data = {
          publicId,
          displayName,
          inviteCode,
          recoveryCode,
          avatarFileId: null,
          nearbyVisible: false,
          showInPeople: true,
          notifyWhenPeopleOnline: true,
          onlineNotificationAudience: 'anyone',
          defaultStoryAudience: 'public',
          createdAt: now,
          updatedAt: now,
        }

        tx.create(profileRef, data)
        tx.create(presenceRef, {
          userId: id,
          isOnline: false,
          lastHeartbeatAt: null,
          lastSeenAt: now,
        })

        return profileFromData(id, data)
      })

      return profile
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'IDENTITY_CODE_COLLISION' &&
        attempt < 4
      ) {
        continue
      }

      console.error('[session] Failed to create Firebase identity:', error)
      throw error
    }
  }

  throw new Error('Could not generate a unique identity after five attempts.')
}

export async function createSessionForUser(userId: string) {
  const firestore = getFirebaseAdminFirestore()
  const token = generateToken()
  const socketToken = generateToken()
  const now = Date.now()

  const session: SessionRecord = {
    id: token,
    token,
    socketToken,
    userId,
    createdAt: new Date(now),
    lastSeenAt: new Date(now),
    expiresAt: new Date(now + SESSION_TTL_MS),
  }

  await firestore.collection('sessions').doc(token).create({
    token,
    socketToken,
    userId,
    createdAt: Timestamp.fromMillis(now),
    lastSeenAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + SESSION_TTL_MS),
  })

  return session
}

export async function findProfileByRecoveryCode(candidates: string[]) {
  const firestore = getFirebaseAdminFirestore()

  for (const candidate of candidates) {
    const result = await firestore.collection('profiles')
      .where('recoveryCode', '==', candidate)
      .limit(1)
      .get()

    if (!result.empty) {
      const doc = result.docs[0]
      return profileFromData(doc.id, doc.data())
    }
  }

  return null
}
