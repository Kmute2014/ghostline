"use client";

import { api } from '@/lib/client-api'

/**
 * Browser-side Web Push helpers. All functions are safe to call on
 * unsupported platforms — they return structured results instead of throwing.
 */

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

/** iPhone / iPad / iPod (iPadOS 13+ reports itself as Macintosh + touch). */
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

export type EnablePushResult = { ok: true } | { ok: false; reason: string }

/**
 * Full subscribe flow: permission prompt → PushManager.subscribe → register
 * the subscription with the server. MUST be called from a user gesture.
 */
export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported()) {
    return { ok: false, reason: 'This browser does not support push notifications.' }
  }
  try {
    const config = await api.getPushConfig()
    if (!config.enabled || !config.publicKey) {
      return { ok: false, reason: 'Push notifications are not available on this server.' }
    }

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      return { ok: false, reason: 'Notification permission was not granted.' }
    }

    const reg = await navigator.serviceWorker.ready
    const existing = await reg.pushManager.getSubscription()
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey) as BufferSource,
      }))

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, reason: 'The browser returned an invalid subscription.' }
    }

    await api.subscribePush({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Could not enable notifications.',
    }
  }
}

/** Unsubscribes the current browser and removes the record server-side. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await api.unsubscribePush(sub.endpoint).catch(() => undefined)
      await sub.unsubscribe().catch(() => undefined)
    }
  } catch {
    /* best-effort */
  }
}
