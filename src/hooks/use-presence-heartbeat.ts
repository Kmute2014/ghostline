'use client'

import { useEffect } from 'react'

/** Keeps Firestore presence online while this authenticated app is active. */
export function usePresenceHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return

    let stopped = false
    let requestInFlight = false

    const beat = async () => {
      if (stopped || requestInFlight || document.visibilityState !== 'visible') return
      requestInFlight = true
      try {
        const response = await fetch('/api/presence/heartbeat', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response.ok) {
          console.warn(`[presence] heartbeat failed (${response.status})`)
        }
      } catch (error) {
        console.warn('[presence] heartbeat request failed:', error)
      } finally {
        requestInFlight = false
      }
    }

    void beat()
    const timer = window.setInterval(() => void beat(), 20_000)
    const onWake = () => void beat()
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)

    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [enabled])
}
