'use client';

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BellRing,
  Download,
  Globe,
  Loader2,
  Maximize2,
  MoreVertical,
  Share,
  Smartphone,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { usePwaRuntime } from '@/hooks/use-pwa'

type PwaRuntime = ReturnType<typeof usePwaRuntime>

/**
 * How long the app waits (user onboarded, idle, out of chat, notification
 * question settled) before the install popup auto-opens on a phone.
 */
const AUTO_PROMPT_DELAY_MS = 6000

/**
 * Add-to-Home-Screen popup with triggers:
 *  - `native`  — Android/Chrome where the browser handed us the
 *                `beforeinstallprompt` event: the "Install app" button fires
 *                the REAL native install dialog (the closest a web app can
 *                get to "auto add to home screen").
 *  - `ios`     — iPhone/iPad Safari: no install API exists, so the sheet
 *                walks the user through Share → "Add to Home Screen" (which
 *                is also required there for push notifications).
 *  - `manual`  — browsers without the event (Firefox/Samsung…): menu steps.
 *
 * Dismissal is session-only (in-memory) — a refresh brings the popup back
 * until the app is actually installed (standalone / appinstalled).
 */
export function InstallPrompt({
  pwa,
  active,
  open,
  onOpenChange,
}: {
  pwa: PwaRuntime
  /** Every auto-trigger gate passed (phone, not installed, notifications settled, not in chat). */
  active: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [dismissed, setDismissed] = useState(false) // session-only
  const [busy, setBusy] = useState(false)
  const openRef = useRef(open)
  openRef.current = open

  const variant = pwa.isIOS ? 'ios' : pwa.canInstall ? 'native' : 'manual'

  // Trigger 1 — the browser itself says "installable" (canInstall flips true
  // when beforeinstallprompt is captured). Open right away: that is the
  // strongest moment to ask.
  useEffect(() => {
    if (active && pwa.canInstall && !dismissed && !openRef.current) onOpenChange(true)
  }, [active, pwa.canInstall, dismissed, onOpenChange])

  // Trigger 2 — delayed auto-open for platforms that never fire the event
  // (iOS Safari and event-less Android browsers).
  useEffect(() => {
    if (!active || pwa.canInstall || dismissed) return
    const timer = setTimeout(() => {
      if (!openRef.current) onOpenChange(true)
    }, AUTO_PROMPT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [active, pwa.canInstall, dismissed, onOpenChange])

  const close = useCallback(() => {
    setDismissed(true)
    onOpenChange(false)
  }, [onOpenChange])

  async function handleInstall() {
    setBusy(true)
    try {
      const result = await pwa.promptInstall()
      if (result === 'accepted') {
        toast.success('Ghostline installed — find it on your home screen.')
        close()
      } else if (result === 'dismissed') {
        close()
      } else {
        // The captured event went stale — fall back to menu instructions.
        toast('Use your browser menu → “Install app” / “Add to Home screen”.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close()
      }}
    >
      <DialogContent
        showCloseButton
        aria-describedby={undefined}
        className={/* mobile bottom sheet → desktop centered card */
        [
          'top-auto bottom-0 left-1/2 w-full max-w-none -translate-x-1/2 translate-y-0',
          'rounded-t-3xl rounded-b-none border-x-0 border-b-0',
          'px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] gap-4',
          'md:top-[50%] md:bottom-auto md:max-w-md md:translate-y-[-50%]',
          'md:rounded-3xl md:border-x md:border-b md:px-6 md:pb-6',
        ].join(' ')}
      >
        <div className="flex items-start gap-3.5">
          <img
            src="/icon-192.png"
            alt="Ghostline app icon"
            width={56}
            height={56}
            className="h-14 w-14 shrink-0 rounded-2xl border bg-background/60 shadow-sm"
          />
          <div className="min-w-0 space-y-1.5">
            <DialogTitle className="flex items-center gap-2 pr-6 text-base leading-snug">
              <Smartphone className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              {variant === 'ios' ? 'Add Ghostline to your Home Screen' : 'Install the Ghostline app'}
            </DialogTitle>
            <DialogDescription className="pr-6 text-[13px] leading-snug">
              {variant === 'ios'
                ? 'On iPhone, the full-screen app and push notifications only work from the Home Screen icon. It takes a few taps:'
                : variant === 'native'
                  ? 'One tap and Ghostline sits on your home screen like a normal app.'
                  : 'Your browser installs web apps straight from its menu. Two taps:'}
            </DialogDescription>
          </div>
        </div>

        {variant === 'ios' && (
          <div className="space-y-3">
            {/* Safari toolbar mock — highlights the Share button (step 1) */}
            <div className="flex items-center justify-between rounded-xl border bg-muted/40 px-3 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Globe className="h-3.5 w-3.5" aria-hidden /> ghostline.app
              </div>
              <span
                className="flex h-8 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30"
                aria-hidden
              >
                <Share className="h-4 w-4" />
              </span>
            </div>
            <ol className="space-y-2 text-sm">
              <InstallStep n={1}>
                Tap the <strong className="font-medium">Share</strong> button{' '}
                <Share className="inline h-3.5 w-3.5 align-[-2px]" aria-label="Share icon" /> in
                Safari&apos;s toolbar
              </InstallStep>
              <InstallStep n={2}>
                Scroll down and tap <strong className="font-medium">&ldquo;Add to Home Screen&rdquo;</strong>
              </InstallStep>
              <InstallStep n={3}>
                Tap <strong className="font-medium">&ldquo;Add&rdquo;</strong> — Ghostline gets its own icon
              </InstallStep>
            </ol>
          </div>
        )}

        {variant === 'native' && (
          <ul className="space-y-2 text-sm">
            <NativeBenefit icon={<BellRing className="h-4 w-4" aria-hidden />}>
              Message alerts even when the app is closed
            </NativeBenefit>
            <NativeBenefit icon={<Maximize2 className="h-4 w-4" aria-hidden />}>
              Full-screen — no browser bars, no tabs
            </NativeBenefit>
            <NativeBenefit icon={<Zap className="h-4 w-4" aria-hidden />}>
              Opens instantly from your home screen
            </NativeBenefit>
          </ul>
        )}

        {variant === 'manual' && (
          <ol className="space-y-2 text-sm">
            <InstallStep n={1}>
              Open your browser menu{' '}
              <MoreVertical className="inline h-3.5 w-3.5 align-[-2px]" aria-label="three-dot menu" />
            </InstallStep>
            <InstallStep n={2}>
              Tap <strong className="font-medium">&ldquo;Install app&rdquo;</strong> or{' '}
              <strong className="font-medium">&ldquo;Add to Home screen&rdquo;</strong>
            </InstallStep>
          </ol>
        )}

        <div className="flex gap-2.5">
          {variant === 'native' ? (
            <>
              <Button variant="outline" className="flex-1" onClick={close} disabled={busy}>
                Not now
              </Button>
              <Button className="flex-1" onClick={() => void handleInstall()} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Download className="h-4 w-4" aria-hidden />
                )}
                Install app
              </Button>
            </>
          ) : (
            <Button className="w-full" onClick={close}>
              Got it
            </Button>
          )}
        </div>

        {variant === 'ios' && (
          <p className="text-center text-[11px] text-muted-foreground">
            Works in Safari — look for the Share button: a square with an arrow pointing up.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

function InstallStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 leading-snug">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {n}
      </span>
      <span>{children}</span>
    </li>
  )
}

function NativeBenefit({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 leading-snug">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  )
}
