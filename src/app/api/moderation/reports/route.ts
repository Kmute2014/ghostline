import { NextRequest } from 'next/server'
import { FieldValue } from 'firebase-admin/firestore'
import { handle, ok, fail } from '@/lib/api-helpers'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { normalizeFirestoreValue } from '@/lib/firestore-route-helpers'

export const dynamic = 'force-dynamic'

function checkToken(req: NextRequest): Response | null {
  const expected = process.env.MODERATION_TOKEN
  if (!expected) return fail(503, 'MODERATION_DISABLED', 'Set MODERATION_TOKEN to enable the review API.')
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (provided !== expected) return fail(401, 'UNAUTHORIZED', 'Invalid moderation token.')
  return null
}

export const GET = handle(async (req: NextRequest) => {
  const denied = checkToken(req)
  if (denied) return denied
  const firestore = getFirebaseAdminFirestore()
  const status = new URL(req.url).searchParams.get('status')
  let query: FirebaseFirestore.Query = firestore.collection('abuseReports')
  if (status) query = query.where('status', '==', status)
  const snapshot = await query.orderBy('createdAt', 'desc').limit(100).get()
  const reports = await Promise.all(snapshot.docs.map(async (doc) => {
    const row = normalizeFirestoreValue(doc.data())
    const [reporterSnap, targetSnap] = await Promise.all([
      row.reporterId ? firestore.collection('profiles').doc(String(row.reporterId)).get() : Promise.resolve(null),
      row.reportedUserId ? firestore.collection('profiles').doc(String(row.reportedUserId)).get() : Promise.resolve(null),
    ])
    const reporterData = reporterSnap?.exists ? reporterSnap.data() : null
    const targetData = targetSnap?.exists ? targetSnap.data() : null
    return {
      id: doc.id, reason: row.reason, details: row.details ?? null, status: row.status,
      createdAt: row.createdAt?.toISOString?.() ?? null,
      reporter: reporterData ? { publicId: reporterData.publicId, displayName: reporterData.displayName } : null,
      reportedUser: targetData ? { publicId: targetData.publicId, displayName: targetData.displayName } : null,
      conversationId: row.conversationId ?? null,
    }
  }))
  return ok({ reports })
})

export const PATCH = handle(async (req: NextRequest) => {
  const denied = checkToken(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const { reportId, status } = body ?? {}
  if (!reportId || !['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) return fail(400, 'BAD_REQUEST', 'reportId and a valid status are required.')
  const firestore = getFirebaseAdminFirestore()
  const ref = firestore.collection('abuseReports').doc(String(reportId))
  const snap = await ref.get()
  if (!snap.exists) return fail(404, 'NOT_FOUND', 'Report not found.')
  await ref.update({ status, resolvedAt: ['resolved', 'dismissed'].includes(status) ? FieldValue.serverTimestamp() : null })
  return ok({ id: ref.id, status })
})
