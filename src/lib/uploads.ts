import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { ApiError, badRequest } from '@/lib/api-helpers'

/**
 * Local object storage. Files live outside /public and are ONLY served through
 * the authorized GET /api/files/[id] route (participant / audience checks).
 */

const UPLOAD_DIR = path.join(process.cwd(), 'uploads')

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime']

export const UPLOAD_LIMITS = {
  image: 8 * 1024 * 1024, // 8 MB
  video: 50 * 1024 * 1024, // 50 MB
  avatar: 4 * 1024 * 1024, // 4 MB
}

export type UploadKind = 'image' | 'video' | 'avatar'

/** Light magic-byte sniffing so a renamed .exe cannot pass as an image. */
function sniffMime(buf: Buffer, declaredMime: string): string | null {
  if (buf.length < 12) return null
  const b = buf
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  if (declaredMime === 'video/quicktime' && (b[4] === 0x66 || b[0] === 0x00)) return 'video/quicktime'
  return null
}

export async function saveUpload(
  raw: File,
  kind: UploadKind,
  ownerId: string
): Promise<{ id: string; kind: string; mime: string; size: number; url: string }> {
  const allowedMimes = kind === 'video' ? VIDEO_MIMES : IMAGE_MIMES
  if (!allowedMimes.includes(raw.type)) {
    throw badRequest(
      `Unsupported file type. Allowed: ${allowedMimes.join(', ')}.`,
      'UNSUPPORTED_MEDIA'
    )
  }
  const limit = UPLOAD_LIMITS[kind]
  if (raw.size > limit) {
    throw badRequest(`File is too large. Maximum ${Math.round(limit / 1024 / 1024)} MB.`, 'FILE_TOO_LARGE')
  }
  if (raw.size === 0) throw badRequest('File is empty.', 'EMPTY_FILE')

  const buf = Buffer.from(await raw.arrayBuffer())
  const sniffed = sniffMime(buf, raw.type)
  const mime = sniffed ?? raw.type
  if (!allowedMimes.includes(mime)) {
    throw badRequest('File content does not match its type.', 'INVALID_CONTENT')
  }

  const ext =
    mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : mime === 'video/webm' ? 'webm' : mime === 'video/quicktime' ? 'mov' : 'mp4'
  const dir = path.join(UPLOAD_DIR, kind)
  await mkdir(dir, { recursive: true })
  const name = `${Date.now().toString(36)}-${crypto.randomUUID()}`
  const storagePath = `${kind}/${name}.${ext}`
  await writeFile(path.join(UPLOAD_DIR, storagePath), buf)

  const row = await db.file.create({
    data: { ownerId, kind, mime, size: buf.length, storagePath },
  })

  return { id: row.id, kind: row.kind, mime: row.mime, size: row.size, url: `/api/files/${row.id}` }
}

export async function loadStoredFile(fileId: string) {
  const row = await db.file.findUnique({ where: { id: fileId } })
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'File not found.')
  const abs = path.join(UPLOAD_DIR, row.storagePath)
  let data: Buffer
  try {
    data = await readFile(abs)
  } catch {
    throw new ApiError(404, 'NOT_FOUND', 'File contents are no longer available.')
  }
  return { row, data }
}

/** Deletes a file row and its bytes (used by cleanup + account deletion). */
export async function destroyFileRow(fileId: string | null | undefined) {
  if (!fileId) return
  const row = await db.file.findUnique({ where: { id: fileId } })
  if (!row) return
  await db.file.delete({ where: { id: row.id } }).catch(() => undefined)
  await unlink(path.join(UPLOAD_DIR, row.storagePath)).catch(() => undefined)
}

/** Unlinks storage when the DB row is already gone (cascade deletions). */
export async function unlinkByStoragePath(storagePath: string | null | undefined) {
  if (!storagePath) return
  await unlink(path.join(UPLOAD_DIR, storagePath)).catch(() => undefined)
}
