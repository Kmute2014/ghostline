/**
 * Next.js instrumentation hook — runs once per server boot.
 *
 * Boots the Ghostline realtime service (socket.io :3003 + internal notify
 * :3004) in-process so it shares the Next.js process lifetime. If the
 * standalone mini-service (mini-services/realtime) already owns the port,
 * this becomes a no-op — see the port guard in service.ts.
 *
 * Set DISABLE_INPROCESS_REALTIME=1 on hosts where realtime runs as its own
 * service (e.g. Render two-service topology) so the web tier never boots a
 * second, unreachable instance.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.DISABLE_INPROCESS_REALTIME === '1') return
  try {
    const { startRealtimeService } = await import('../mini-services/realtime/service')
    await startRealtimeService()
  } catch (err) {
    console.error('[rt] in-process realtime boot failed:', err)
  }
}
