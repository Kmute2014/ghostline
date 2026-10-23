import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { generateToken, generatePublicId, generateInviteCode, generateRecoveryCode } from '@/lib/ids'

export const SESSION_COOKIE = 'ghostline_session'
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1 year, sliding
const SESSION_EXTEND_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000 // extend when < 60 days left

export type AuthContext = {
  profile: {
    id: string
    publicId: string
    displayName: string
    inviteCode: string
    recoveryCode: string
    avatarFileId: string | null
    nearbyVisible: boolean
    showInPeople: boolean
    defaultStoryAudience: string
    createdAt: Date
  }
  sessionId: string
  token: string
}

async function loadSessionByToken(token: string) {
  const session = await db.session.findUnique({
    where: { token },
    include: { user: true },
  })
  if (!session) return null
  const now = new Date()
  if (session.expiresAt.getTime() < now.getTime()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined)
    return null
  }
  return session
}

/** Reads the session cookie and resolves the authenticated anonymous profile. */
export async function getAuth(): Promise<AuthContext | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null
  const session = await loadSessionByToken(token)
  if (!session) return null

  // Sliding expiration + throttled lastSeen refresh
  const now = Date.now()
  const remaining = session.expiresAt.getTime() - now
  if (remaining < SESSION_EXTEND_THRESHOLD_MS) {
    await db.session
      .update({ where: { id: session.id }, data: { expiresAt: new Date(now + SESSION_TTL_MS), lastSeenAt: new Date() } })
      .catch(() => undefined)
  } else if (now - session.lastSeenAt.getTime() > 10 * 60_000) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined)
  }

  return { profile: session.user, sessionId: session.id, token }
}

/** Like getAuth but throws a 401-shaped error consumed by api-helpers. */
export async function requireAuth(): Promise<AuthContext> {
  const auth = await getAuth()
  if (!auth) {
    const err = new Error('Authentication required') as Error & { status?: number; code?: string }
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
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' })
  return res
}

/** Creates the anonymous identity (no phone/email/password anywhere). */
export async function createAnonymousIdentity(displayName: string) {
  let profile: { id: string } | null = null
  let publicId = generatePublicId()
  let inviteCode = generateInviteCode()
  let recoveryCode = generateRecoveryCode()

  // Retry on the (astronomically unlikely) unique collision
  for (let attempt = 0; attempt < 5 && !profile; attempt++) {
    try {
      profile = await db.profile.create({
        data: {
          publicId,
          displayName,
          inviteCode,
          recoveryCode,
          presence: { create: {} },
        },
      })
    } catch {
      publicId = generatePublicId()
      inviteCode = generateInviteCode()
      recoveryCode = generateRecoveryCode()
    }
  }
  if (!profile) throw new Error('Could not create identity')

  // Fresh location row placeholder is not created — discovery is opt-in.
  return db.profile.findUnique({ where: { id: profile.id } })
}

export async function createSessionForUser(userId: string) {
  const token = generateToken()
  const socketToken = generateToken()
  const session = await db.session.create({
    data: { token, socketToken, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  })
  return session
}
