import { NextRequest } from 'next/server'
import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { saveUpload, type UploadKind } from '@/lib/uploads'
import { rateLimit, LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const KINDS: UploadKind[] = ['image', 'video', 'avatar']

/**
 * Multipart upload for chat attachments, stories and avatars.
 * Validates MIME type (with magic-byte sniffing) and size, stores bytes in
 * local object storage and returns an opaque /api/files/{id} URL — bytes are
 * only served after per-resource authorization checks.
 */
export const POST = handle(async (req: NextRequest) => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`upload:${auth.profile.id}`, LIMITS.upload.limit, LIMITS.upload.windowMs)) {
    throw tooMany('Too many uploads in a short time. Please wait a moment.', 60)
  }

  const form = await req.formData().catch(() => null)
  if (!form) throw badRequest('Expected multipart/form-data.', 'BAD_FORM')
  const kindRaw = String(form.get('kind') ?? '')
  if (!KINDS.includes(kindRaw as UploadKind)) throw badRequest('Unknown upload kind.', 'BAD_KIND')
  const raw = form.get('file')
  if (!(raw instanceof File)) throw badRequest('A file is required.', 'NO_FILE')

  const saved = await saveUpload(raw, kindRaw as UploadKind, auth.profile.id)
  return ok(saved)
})
