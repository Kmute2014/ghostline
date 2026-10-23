import { NextRequest, NextResponse } from 'next/server'
import { getAuth } from '@/lib/session'
import { db } from '@/lib/db'
import { loadStoredFile } from '@/lib/uploads'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Authorized media gateway. Files are NEVER publicly readable — access is
 * derived from what references them:
 *   - avatar            → public
 *   - message media     → conversation participants only
 *   - story media       → audience check (public / creator's saved contacts)
 *   - anything else     → owner only
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const auth = await getAuth()
    if (!auth) {
      return NextResponse.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign-in required.' } }, { status: 401 })
    }
    const { id } = await ctx.params
    const meId = auth.profile.id

    const file = await db.file.findUnique({ where: { id } })
    if (!file) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'File not found.' } }, { status: 404 })
    }

    let allowed = file.ownerId === meId

    if (!allowed && file.kind === 'avatar') {
      allowed = true
    }

    if (!allowed) {
      const message = await db.message.findFirst({ where: { fileId: id }, select: { conversationId: true } })
      if (message) {
        const participant = await db.conversationParticipant.findFirst({
          where: { conversationId: message.conversationId, userId: meId },
        })
        allowed = Boolean(participant)
      }
    }

    if (!allowed) {
      const story = await db.story.findFirst({ where: { fileId: id }, include: { owner: true } })
      if (story && story.status === 'active' && story.expiresAt.getTime() > Date.now()) {
        if (story.audience === 'public') {
          const blocked = await db.blockedUser.findFirst({
            where: { OR: [{ blockerId: story.ownerId, blockedId: meId }, { blockerId: meId, blockedId: story.ownerId }] },
          })
          allowed = !blocked
        } else {
          const saved = await db.contact.findFirst({ where: { ownerId: story.ownerId, contactId: meId } })
          allowed = Boolean(saved)
        }
      }
    }

    if (!allowed) {
      return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'You cannot access this file.' } }, { status: 403 })
    }

    const { row, data } = await loadStoredFile(id)

    const headers = new Headers({
      'Content-Type': row.mime,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    })

    // Basic single-range support so <video> can stream (206 responses).
    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0
        const end = m[2] ? Math.min(parseInt(m[2], 10), data.length - 1) : data.length - 1
        if (start <= end && start < data.length) {
          const slice = data.subarray(start, end + 1)
          headers.set('Content-Range', `bytes ${start}-${end}/${data.length}`)
          headers.set('Content-Length', String(slice.length))
          headers.set('Accept-Ranges', 'bytes')
          return new NextResponse(new Uint8Array(slice), { status: 206, headers })
        }
      }
    }

    headers.set('Content-Length', String(data.length))
    headers.set('Accept-Ranges', 'bytes')
    return new NextResponse(new Uint8Array(data), { status: 200, headers })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    const code = (err as { code?: string }).code ?? 'INTERNAL'
    const message = (err as { message?: string }).message ?? 'Could not load file.'
    return NextResponse.json({ error: { code, message } }, { status: status === 404 ? 404 : 500 })
  }
}
