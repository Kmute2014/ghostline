
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  generateToken,
  generatePublicId,
  generateInviteCode,
  generateRecoveryCode,
} from '@/lib/ids'

export const SESSION_COOKIE = 'ghostline_session'

const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1 year, sliding
const SESSION_EXTEND_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000 // Extend when less than 60 days remain

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

  if (session.expiresAt.getTime() < Date.now()) {
    await db.session
      .delete({ where: { id: session.id } })
      .catch(() => undefined)

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

  // Sliding expiration + throttled lastSeen refresh.
  const now = Date.now()
  const remaining = session.expiresAt.getTime() - now

  if (remaining < SESSION_EXTEND_THRESHOLD_MS) {
    await db.session
      .update({
        where: { id: session.id },
        data: {
          expiresAt: new Date(now + SESSION_TTL_MS),
          lastSeenAt: new Date(),
        },
      })
      .catch(() => undefined)
  } else if (now - session.lastSeenAt.getTime() > 10 * 60_000) {
    await db.session
      .update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => undefined)
  }

  return {
    profile: session.user,
    sessionId: session.id,
    token,
  }
}

/** Like getAuth but throws a 401-shaped error consumed by api-helpers. */
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

/** Creates an anonymous identity without email, phone, or password. */
export async function createAnonymousIdentity(displayName: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const publicId = generatePublicId()
    const inviteCode = generateInviteCode()
    const recoveryCode = generateRecoveryCode()

    try {
      return await db.$transaction(async (tx) => {
        // Keep concurrent identity creations from selecting the same display name.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(0, 1196576844)`

        let availableDisplayName = displayName
        let suffix = 2
        while (
          await tx.profile.findFirst({
            where: {
              displayName: { equals: availableDisplayName, mode: 'insensitive' },
            },
            select: { id: true },
          })
        ) {
          const ending = `-${suffix}`
          availableDisplayName = `${displayName.slice(0, 24 - ending.length).trimEnd()}${ending}`
          suffix++
        }

        return tx.profile.create({
          data: {
            publicId,
            displayName: availableDisplayName,
            inviteCode,
            recoveryCode,
            presence: { create: {} },
          },
        })
      })
    } catch (error: unknown) {
      const isUniqueConstraintError =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'

      if (isUniqueConstraintError && attempt < 4) {
        console.warn(
          `[session] Unique constraint conflict creating identity; retrying (${attempt + 1}/5).`
        )
        continue
      }

      // Log the real error on the server so the underlying issue can be diagnosed.
      console.error('[session] Failed to create anonymous identity:', error)

      throw error
    }
  }

  throw new Error(
    'Could not create identity after repeated unique-constraint conflicts.'
  )
}

export async function createSessionForUser(userId: string) {
  const token = generateToken()
  const socketToken = generateToken()

  const session = await db.session.create({
    data: {
      token,
      socketToken,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  })

  return session
}
