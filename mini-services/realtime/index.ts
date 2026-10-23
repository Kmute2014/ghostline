/**
 * Standalone entry for the Ghostline realtime service.
 * Production deployment: `bun run dev` in this folder (or run.sh with auto-restart).
 * In the sandbox, src/instrumentation.ts starts the SAME service in-process if
 * this standalone instance is not running — the port guard makes both safe.
 *
 * PaaS note (Render): the platform exposes exactly one port via PORT. Map it
 * to RT_PORT here — the in-process boot must never honor PORT, because Next.js
 * sets PORT for its own HTTP server and the realtime service would try to bind
 * the app's port.
 */
if (!process.env.RT_PORT && process.env.PORT) {
  process.env.RT_PORT = process.env.PORT
}

import { startRealtimeService } from './service'

startRealtimeService().catch((e) => {
  console.error('[rt] failed to start:', e)
  process.exit(1)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
