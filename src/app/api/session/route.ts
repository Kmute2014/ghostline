import { NextRequest, NextResponse } from 'next/server'
import { handle, ok, badRequest, tooMany, ApiError } from '@/lib/api-helpers'
import {
  getAuth,
  createAnonymousIdentity,
  createSessionForUser,
  attachSessionCookie,
} from '@/lib/session'
import { toOwnProfile } from '@/lib/dto'
import { db } from '@/lib/db'
import { rateLimit } from '@/lib/rate-limit'
import { normalizeCode, isValidCodeShape } from '@/lib/ids'

export const dynamic = 'force-dynamic'

const NAME_RE = /^[\p{L}\p{N} _.'-]{2,24}$/u

function validateDisplayName(name: string | undefined): string {
  const trimmed = (name ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return `Hush-${Math.floor(1000 + Math.random() * 9000)}`
  if (!NAME_RE.test(trimmed)) {
    throw badRequest('Display name must be 2–24 letters, numbers or spaces.', 'INVALID_NAME')
  }
  return trimmed
}

async function migrateLegacyDisplayName(
  profile: NonNullable<Awaited<ReturnType<typeof getAuth>>>['profile'],
) {
  const match = /^Ghost-(\d{4})$/i.exec(profile.displayName)
  if (!match) return profile

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(0, 1196576844)`

    const baseName = `Hush-${match[1]}`
    let displayName = baseName
    let suffix = 2
    while (
      await tx.profile.findFirst({
        where: {
          id: { not: profile.id },
          displayName: { equals: displayName, mode: 'insensitive' },
        },
        select: { id: true },
      })
    ) {
      displayName = `${baseName}-${suffix}`
      suffix++
    }

    return tx.profile.update({
      where: { id: profile.id },
      data: { displayName },
    })
  })
}

function ipKey(req: NextRequest) {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  )
}

/** Bootstrap check: does this browser already hold an anonymous identity? */
export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) {
    return ok({ authenticated: false, profile: null, socketToken: null })
  }
  const profile = await migrateLegacyDisplayName(auth.profile)
  const [presence, location] = await Promise.all([
    db.presence.findUnique({ where: { userId: profile.id } }),
    db.location.findUnique({ where: { userId: profile.id } }),
  ])
  const session = await db.session.findUnique({ where: { token: auth.token } })
  return ok({
    authenticated: true,
    profile: toOwnProfile(profile, presence, location),
    socketToken: session?.socketToken ?? null,
  })
})

/** Creates a new anonymous identity. No email, phone or password involved. */
export const POST = handle(async (req: NextRequest) => {
  if (!rateLimit(`signup:${ipKey(req)}`, 20, 60 * 60_000)) {
    throw tooMany('Too many identities created from this network. Try later.', 3600)
  }
  const body = await req.json().catch(() => ({}))
  const displayName = validateDisplayName(body?.displayName)

  const profile = await createAnonymousIdentity(displayName)
  if (!profile) throw new ApiError(500, 'INTERNAL', 'Could not create identity.')
  const session = await createSessionForUser(profile.id)

  const res = NextResponse.json({
    authenticated: true,
    isNewUser: true,
    profile: toOwnProfile(profile, await db.presence.findUnique({ where: { userId: profile.id } }), null),
    socketToken: session.socketToken,
  })
  return attachSessionCookie(res, session.token)
})

/**
 * Optional identity recovery: binds this browser to an existing identity
 * using the recovery code shown in Profile → Identity recovery.
 */
export const PUT = handle(async (req: NextRequest) => {
  if (!rateLimit(`recover:${ipKey(req)}`, 10, 60 * 60_000)) {
    throw tooMany('Too many recovery attempts. Try again later.', 3600)
  }
  const body = await req.json().catch(() => ({}))
  const code = normalizeCode(String(body?.recoveryCode ?? ''))
  if (!isValidCodeShape(code, 12, 16)) {
    throw badRequest('That recovery code does not look right.', 'INVALID_RECOVERY_CODE')
  }
  // Stored form is dashed ("RXXXXX-XXXXX-XXXXX"); accept dashed or plain input.
  const candidates = [code]
  if (code.length === 15) {
    candidates.unshift(`R${code.slice(1, 5)}-${code.slice(5, 10)}-${code.slice(10, 15)}`)
  }
  const profile = await db.profile.findFirst({ where: { recoveryCode: { in: candidates } } })
  if (!profile) {
    throw badRequest('No identity matches this recovery code.', 'RECOVERY_NOT_FOUND')
  }
  const session = await createSessionForUser(profile.id)
  const res = NextResponse.json({
    authenticated: true,
    recovered: true,
    profile: toOwnProfile(profile, await db.presence.findUnique({ where: { userId: profile.id } }), null),
    socketToken: session.socketToken,
  })
  return attachSessionCookie(res, session.token)
})
