"use client";

import { useCallback, useEffect, useState } from 'react'
import { BellRing, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { enablePush, pushSupported } from '@/lib/push-client'

/**
 * Pops up on EVERY app load until notifications are actually enabled on this
 * device (permission granted + a push subscription registered). "Not now" only
 * dismisses for the current in-memory session — a refresh brings it right
 * back. If the OS permission is already denied the loop stops: the browser has
 * the final word there, and the Profile card covers manual recovery.
 *
 * `onResolved` fires once the question is settled either way (enabled,
 * unsupported, denied, or dismissed this session) — used to sequence other
 * popups (e.g. the install prompt) behind this one.
 */
export function NotificationPrompt({
  active,
  onResolved,
}: {
  active: boolean
  onResolved?: () => void
}) {
  const [state, setState] = useState<'checking' | 'needed' | 'not-needed'>('checking')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (state === 'not-needed') onResolved?.()
  }, [state, onResolved])

  const evaluate = useCallback(async () => {
    if (!pushSupported()) {
      setState('not-needed')
      return
    }
    const permission = Notification.permission
    if (permission === 'denied') {
      setState('not-needed')
      return
    }
    if (permission === 'default') {
      setState('needed')
      return
    }
    // granted — "enabled" also requires an actual device subscription
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      setState(sub ? 'not-needed' : 'needed')
    } catch {
      setState('needed')
    }
  }, [])

  useEffect(() => {
    void evaluate()
  }, [evaluate])

  async function handleEnable() {
    setBusy(true)
    try {
      const result = await enablePush() // must run inside the click gesture
      if (result.ok) {
        toast.success("Notifications enabled — you'll get pings even when the app is closed.")
        setState('not-needed')
      } else {
        toast.error(result.reason)
        setState('not-needed') // next refresh will ask again
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={state === 'needed' && active}
      onOpenChange={(open) => {
        if (!open) setState('not-needed') // dismissed for this session only
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-primary" aria-hidden /> Enable notifications?
          </DialogTitle>
          <DialogDescription>
            Hushly can pop up a notification when someone messages you — even while the app is
            closed. You can change this anytime from your Profile.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setState('not-needed')} disabled={busy}>
            Not now
          </Button>
          <Button onClick={() => void handleEnable()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <BellRing className="h-4 w-4" aria-hidden />
            )}
            Enable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
