import { handle, ok } from '@/lib/api-helpers'

/** Platform liveness probe (Render healthCheckPath). Intentionally DB-free. */
export const dynamic = 'force-dynamic'

export const GET = handle(async () => ok({ ok: true, ts: new Date().toISOString() }))
