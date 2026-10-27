import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { ApiError } from '@/lib/api-helpers'

export const UPLOAD_LIMITS = {
  image: 8 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  avatar: 4 * 1024 * 1024,
}

export type UploadKind = 'image' | 'video' | 'avatar'

/**
 * Media uploads remain disabled during the Hushly migration. No new media
 * bytes are stored by this application.
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

/** Existing media bytes are no longer served through this helper. */
export async function loadStoredFile(_fileId: string): Promise<never> {
  throw new ApiError(
    410,
    'MEDIA_UNAVAILABLE',
    'This media is unavailable because media storage has been disabled.',
  )
}

/** Remove Firestore file metadata; this does not delete cloud storage objects. */
export async function destroyFileRow(
  fileId: string | null | undefined,
): Promise<void> {
  if (!fileId) return

  const firestore = getFirebaseAdminFirestore()
  const fileRef = firestore.collection('files').doc(fileId)
  const snapshot = await fileRef.get()
  if (!snapshot.exists) return

  await fileRef.delete()
}

/** Kept for compatibility; external storage cleanup is intentionally disabled. */
export async function unlinkByStoragePath(
  _storagePath: string | null | undefined,
): Promise<void> {
  // Intentionally no-op. Previously stored cloud objects are not deleted here.
}
