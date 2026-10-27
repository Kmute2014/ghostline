import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../src/lib/db'
import { getFirebaseStorageBucket } from '../src/lib/firebase-admin'

const root = path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads'))
const bucket = getFirebaseStorageBucket()
const records = await db.file.findMany({ orderBy: { id: 'asc' } })
let uploaded = 0
let alreadyPresent = 0

for (const record of records) {
  const localPath = path.resolve(root, record.storagePath)
  if (!localPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Invalid storage path in file record ${record.id}.`)
  }

  const destination = bucket.file(record.storagePath)
  const [exists] = await destination.exists()
  if (exists) {
    alreadyPresent += 1
    continue
  }

  let bytes: Buffer
  try {
    bytes = await readFile(localPath)
  } catch (error) {
    throw new Error(`Missing local media for file ${record.id} (${record.storagePath}).`, {
      cause: error,
    })
  }

  if (bytes.length !== record.size) {
    throw new Error(`Size mismatch for file ${record.id}; refusing to upload corrupted media.`)
  }

  await destination.save(bytes, {
    resumable: false,
    metadata: {
      contentType: record.mime,
      cacheControl: 'private, max-age=31536000, immutable',
    },
  })
  uploaded += 1
}

console.log(`Media migration completed: ${uploaded} uploaded, ${alreadyPresent} already present.`)
await db.$disconnect()
