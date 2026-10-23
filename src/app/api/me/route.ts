import { NextRequest } from 'next/server'
import { handle, ok, badRequest, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { toOwnProfile } from '@/lib/dto'
import { db } from '@/lib/db'
import { destroyFileRow } from '@/lib/uploads'

export const dynamic = 'force-dynamic'

const NAME_RE = /^[\p{L}\p{N} _.'-]{2,24}$/u

export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const [presence, location] = await Promise.all([
    db.presence.findUnique({ where: { userId: auth.profile.id } }),
    db.location.findUnique({ where: { userId: auth.profile.id } }),
  ])
  return ok(toOwnProfile(auth.profile, presence, location))
})

export const PATCH = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  const body = await req.json().catch(() => ({}))

  const data: Record<string, unknown> = {}

  if (body.displayName !== undefined) {
    const trimmed = String(body.displayName).trim().replace(/\s+/g, ' ')
    if (!NAME_RE.test(trimmed)) {
      throw badRequest('Display name must be 2–24 letters, numbers or spaces.', 'INVALID_NAME')
    }
    data.displayName = trimmed
  }

  if (body.avatarFileId !== undefined) {
    const fileId = body.avatarFileId === null ? null : String(body.avatarFileId)
    if (fileId) {
      const file = await db.file.findUnique({ where: { id: fileId } })
      if (!file || file.ownerId !== auth.profile.id || file.kind !== 'avatar') {
        throw badRequest('Invalid avatar upload.', 'INVALID_AVATAR')
      }
    }
    const old = auth.profile.avatarFileId
    data.avatarFileId = fileId
    if (old && old !== fileId) {
      await destroyFileRow(old) // replace previous avatar bytes
    }
  }

  if (body.nearbyVisible !== undefined) {
    const v = Boolean(body.nearbyVisible)
    data.nearbyVisible = v
    // Turning discovery off immediately removes stored coordinates.
    if (!v) await db.location.deleteMany({ where: { userId: auth.profile.id } })
  }

  if (body.showInPeople !== undefined) {
    data.showInPeople = Boolean(body.showInPeople)
  }

  if (body.defaultStoryAudience !== undefined) {
    const v = body.defaultStoryAudience === 'friends' ? 'friends' : 'public'
    data.defaultStoryAudience = v
  }

  const profile = await db.profile.update({ where: { id: auth.profile.id }, data })
  const [presence, location] = await Promise.all([
    db.presence.findUnique({ where: { userId: profile.id } }),
    db.location.findUnique({ where: { userId: profile.id } }),
  ])
  return ok(toOwnProfile(profile, presence, location))
})
