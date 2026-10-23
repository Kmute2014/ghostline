import { NextRequest } from 'next/server'
import { handle, ok, fail } from '@/lib/api-helpers'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Moderation review endpoint (server-to-server).
 * Guarded by the MODERATION_TOKEN environment variable — when it is not set,
 * the endpoint is disabled and reports are reviewed directly in the database.
 * GET    → list reports (filter ?status=open)
 * PATCH  → { reportId, status: open|reviewing|resolved|dismissed }
 */
function checkToken(req: NextRequest): Response | null {
  const expected = process.env.MODERATION_TOKEN
  if (!expected) {
    return fail(503, 'MODERATION_DISABLED', 'Set MODERATION_TOKEN to enable the review API.')
  }
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (provided !== expected) return fail(401, 'UNAUTHORIZED', 'Invalid moderation token.')
  return null
}

export const GET = handle(async (req: NextRequest) => {
  const denied = checkToken(req)
  if (denied) return denied

  const status = new URL(req.url).searchParams.get('status')
  const reports = await db.abuseReport.findMany({
    where: status ? { status } : undefined,
    include: {
      reporter: { select: { publicId: true, displayName: true } },
      reportedUser: { select: { publicId: true, displayName: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return ok({
    reports: reports.map((r) => ({
      id: r.id,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      reporter: r.reporter,
      reportedUser: r.reportedUser,
      conversationId: r.conversationId,
    })),
  })
})

export const PATCH = handle(async (req: NextRequest) => {
  const denied = checkToken(req)
  if (denied) return denied
  const body = await req.json().catch(() => ({}))
  const { reportId, status } = body ?? {}
  if (!reportId || !['open', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
    return fail(400, 'BAD_REQUEST', 'reportId and a valid status are required.')
  }
  const report = await db.abuseReport.update({
    where: { id: String(reportId) },
    data: { status, resolvedAt: ['resolved', 'dismissed'].includes(status) ? new Date() : null },
  })
  return ok({ id: report.id, status: report.status })
})
