
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json(
    {
      error: {
        code: 'MEDIA_UNAVAILABLE',
        message:
          'Image, video, and avatar media are temporarily unavailable while Hushly updates its storage system.',
      },
    },
    { status: 410 },
  )
}
