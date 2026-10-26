"use client";

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * PWA runtime for Ghostline — a single hook that:
 *  1. Registers the service worker (app shell caching + push).
 *  2. Captures the `beforeinstallprompt` event so the UI can offer a custom
 *     "Install app" action (Chrome/Edge/Android).
 *  3. Exposes platform facts (standalone mode, iOS) for install hints.
 *  4. Handles notification deep links: taps on push notifications either open
 *     a chat or switch to Buzz, on cold start or in the running app.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as Macintosh with touch support
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function detectAndroid(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android/i.test(navigator.userAgent)
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

export function usePwaRuntime(onDeepLink?: (path: string) => void) {
  const [canInstall, setCanInstall] = useState(false)
  // Lazy initializers: computed once on the client; SSR renders the splash
  // only, so these never participate in hydration.
  const [isStandaloneMode, setIsStandaloneMode] = useState(detectStandalone)
  const [isIOS, setIsIOS] = useState(detectIOS)
  const [isAndroid] = useState(detectAndroid)
  // True once the user accepted a native install (appinstalled fired) — stops
  // every install nudge for good, even if the tab is still in-browser mode.
  // Persisted: a reload right after installing must not resurrect the nag
  // (standalone mode only kicks in on the next launch from the home screen).
  const [installed, setInstalled] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('gl-pwa-installed') === '1',
  )
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null)
  const deepLinkRef = useRef(onDeepLink)

  // Keep the latest callback without re-binding the SW message listener.
  useEffect(() => {
    deepLinkRef.current = onDeepLink
  }, [onDeepLink])

  // Register the service worker once.
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const onLoad = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          // Pick up updates promptly on repeat visits.
          reg.update().catch(() => undefined)
        })
        .catch((err) => console.warn('[pwa] service worker registration failed:', err))
    }
    if (document.readyState === 'complete') onLoad()
    else {
      window.addEventListener('load', onLoad)
      return () => window.removeEventListener('load', onLoad)
    }
  }, [])

  // Install prompt capture (platform facts come from lazy initializers above).
  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault()
      deferredPrompt.current = e as BeforeInstallPromptEvent
      setCanInstall(true)
    }
    const onInstalled = () => {
      deferredPrompt.current = null
      setCanInstall(false)
      setInstalled(true)
      try {
        window.localStorage.setItem('gl-pwa-installed', '1')
      } catch {
        /* private mode */
      }
      setIsStandaloneMode(detectStandalone())
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  // Deep links: cold start via URL (?chat=<id>) + warm taps via SW postMessage.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.search)
    const chat = params.get('chat')
    const tab = params.get('tab')
    if (chat || tab === 'feed') {
      window.history.replaceState(null, '', window.location.pathname)
      deepLinkRef.current?.(chat ? `/?chat=${encodeURIComponent(chat)}` : '/?tab=feed')
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null
      if (
        (data?.type === 'open-chat' || data?.type === 'open-notification') &&
        typeof data.url === 'string'
      ) {
        const match = data.url.match(/[?&]chat=([^&]+)/)
        if (match) deepLinkRef.current?.(`/?chat=${decodeURIComponent(match[1])}`)
        else if (/[?&]tab=feed(?:&|$)/.test(data.url)) deepLinkRef.current?.('/?tab=feed')
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const promptEvent = deferredPrompt.current
    if (!promptEvent) return 'unavailable'
    await promptEvent.prompt()
    const { outcome } = await promptEvent.userChoice
    deferredPrompt.current = null
    setCanInstall(false)
    return outcome
  }, [])

  return {
    canInstall,
    promptInstall,
    isStandalone: isStandaloneMode,
    isIOS,
    isAndroid,
    /** Any phone platform we actively prompt for install. */
    isMobile: isIOS || isAndroid,
    /** The user accepted the native install dialog on this device. */
    installed,
  }
}
