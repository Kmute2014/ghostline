
import { db } from '@/lib/db'
import { ApiError, badRequest } from '@/lib/api-helpers'

export const UPLOAD_LIMITS = {
  image: 8 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  avatar: 4 * 1024 * 1024,
}

export type UploadKind = 'image' | 'video' | 'avatar'

/**
 * Media uploads are temporarily disabled while Hushly migrates away
 * from Firebase Storage. No new file bytes are stored.
 */
export async function saveUpload(
  _raw: File,
  _kind: UploadKind,
  _ownerId: string,
): Promise<{
  id: string
  kind: string
  mime: string
  size: number
  url: string
}> {
  throw new ApiError(
    503,
    'MEDIA_DISABLED',
    'Image, video, and avatar uploads are temporarily unavailable.',
  )
}

/**
 * Existing media metadata may remain in the database, but the original
 * file contents are no longer served through this helper.
 */
export async function loadStoredFile(_fileId: string): Promise<never> {
  throw new ApiError(
    410,
    'MEDIA_UNAVAILABLE',
    'This media is unavailable because media storage has been disabled.',
  )
}

/**
 * Remove file metadata when called by existing cleanup code.
 * This does not delete any previously stored cloud objects.
 */
export async function destroyFileRow(
  fileId: string | null | undefined,
): Promise<void> {
  if (!fileId) return

  const row = await db.file.findUnique({ where: { id: fileId } })
  if (!row) return

  await db.file.delete({ where: { id: row.id } })
}

/**
 * Kept temporarily for compatibility with existing callers.
 * Firebase Storage is no longer accessed.
 */
export async function unlinkByStoragePath(
  _storagePath: string | null | undefined,
): Promise<void> {
  // Intentionally no-op. Storage cleanup is not performed here.
}
