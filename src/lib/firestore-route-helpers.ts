import {
  Timestamp,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type Query,
} from 'firebase-admin/firestore'

export function asDate(value: any): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (value instanceof Timestamp) return value.toDate()
  if (typeof value?.toDate === 'function') return value.toDate()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function normalizeFirestoreValue<T = any>(value: T): any {
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(normalizeFirestoreValue)
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const [key, child] of Object.entries(value as Record<string, any>)) {
      out[key] = normalizeFirestoreValue(child)
    }
    return out
  }
  return value
}

export function docData<T = Record<string, any>>(
  snapshot: DocumentSnapshot<DocumentData>,
): (T & { id: string }) | null {
  if (!snapshot.exists) return null
  return { id: snapshot.id, ...normalizeFirestoreValue(snapshot.data()) } as T & { id: string }
}

export async function getProfile(firestore: Firestore, userId: string) {
  return docData(await firestore.collection('profiles').doc(userId).get())
}

export async function getPresence(firestore: Firestore, userId: string) {
  return docData(await firestore.collection('presences').doc(userId).get())
}

export async function getLocation(firestore: Firestore, userId: string) {
  return docData(await firestore.collection('locations').doc(userId).get())
}

export async function isBlockedBetween(
  firestore: Firestore,
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  const [first, second] = await Promise.all([
    firestore.collection('blockedUsers')
      .where('blockerId', '==', firstUserId)
      .where('blockedId', '==', secondUserId)
      .limit(1).get(),
    firestore.collection('blockedUsers')
      .where('blockerId', '==', secondUserId)
      .where('blockedId', '==', firstUserId)
      .limit(1).get(),
  ])
  return !first.empty || !second.empty
}

export async function blockedIdsFor(
  firestore: Firestore,
  userId: string,
): Promise<Set<string>> {
  const [made, received] = await Promise.all([
    firestore.collection('blockedUsers').where('blockerId', '==', userId).get(),
    firestore.collection('blockedUsers').where('blockedId', '==', userId).get(),
  ])
  const blocked = new Set<string>()
  for (const doc of made.docs) {
    const id = String(doc.data().blockedId ?? '')
    if (id && id !== userId) blocked.add(id)
  }
  for (const doc of received.docs) {
    const id = String(doc.data().blockerId ?? '')
    if (id && id !== userId) blocked.add(id)
  }
  return blocked
}

export async function deleteQueryInBatches(
  firestore: Firestore,
  query: Query,
  batchSize = 400,
): Promise<number> {
  let total = 0
  while (true) {
    const snapshot = await query.limit(batchSize).get()
    if (snapshot.empty) break
    const batch = firestore.batch()
    for (const doc of snapshot.docs) batch.delete(doc.ref)
    await batch.commit()
    total += snapshot.size
    if (snapshot.size < batchSize) break
  }
  return total
}

export function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

export async function getProfilesByIds(firestore: Firestore, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))]
  const snapshots = await Promise.all(
    unique.map((id) => firestore.collection('profiles').doc(id).get()),
  )
  return new Map(
    snapshots.filter((s) => s.exists).map((s) => [s.id, docData(s)!]),
  )
}

export async function getPresenceByIds(firestore: Firestore, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))]
  const snapshots = await Promise.all(
    unique.map((id) => firestore.collection('presences').doc(id).get()),
  )
  return new Map(
    snapshots.filter((s) => s.exists).map((s) => [s.id, docData(s)!]),
  )
}

export function firestoreDate(value: unknown): Timestamp | null {
  const date = asDate(value)
  return date ? Timestamp.fromDate(date) : null
}

