"use client";

import { useCallback, useEffect, useState } from 'react'
import { Bell, BellOff, BellRing, Loader2, SendHorizontal, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/client-api'
import type { OwnProfile } from '@/lib/types'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  disablePush,
  enablePush,
  isIOSDevice,
  isStandalone,
  notificationPermission,
  pushSupported,
} from '@/lib/push-client'

type PushView =
  | 'checking'
  | 'unsupported'
  | 'default'
  | 'needs-subscription'
  | 'granted'
  | 'denied'

/**
 * Notifications card for the profile screen: the UI for enabling pop-up push
 * notifications (new-message pings even while Ghostline is closed).
 *
 * Permission state is re-read on mount and whenever the tab becomes visible
 * again — the OS can change it while the app is in the background.
 */
export function NotificationsCard({
  profile,
  applyProfile,
}: {
  profile: OwnProfile
  applyProfile: (profile: OwnProfile) => void
}) {
  const [view, setView] = useState<PushView>('checking')
  const [iosHint, setIosHint] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [prefBusy, setPrefBusy] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    setIosHint(isIOSDevice() && !isStandalone())
    if (!pushSupported()) {
      setView('unsupported')
      return
    }
    const permission = notificationPermission()
    if (permission !== 'granted') {
      setView(permission === 'unsupported' ? 'unsupported' : permission)
      return
    }

    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      setView(subscription ? 'granted' : 'needs-subscription')
    } catch (err) {
      console.warn('[push] could not check this device subscription:', err)
      setView('needs-subscription')
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh())
    return () => window.clearTimeout(timer)
  }, [refresh])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  async function handleEnable() {
    setBusy(true)
    try {
      const result = await enablePush()
      if (result.ok) {
        toast.success("Notifications enabled — you'll get pings even when the app is closed.")
      } else {
        toast.error(result.reason)
      }
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  async function handleDisable() {
    setBusy(true)
    try {
      await disablePush()
      toast('Notifications turned off for this device.')
    } finally {
      setBusy(false)
      refresh()
    }
  }

  async function handleTest() {
    setTesting(true)
    try {
      const res = await api.sendTestPush()
      if (res.delivered > 0) {
        toast.success(
          res.delivered === 1 ? 'Test notification sent' : `Test notification sent to ${res.delivered} devices`,
        )
      } else {
        toast.warning(
          'No test notification was delivered. Check this device’s subscription and the server VAPID configuration.',
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the test notification.')
    } finally {
      setTesting(false)
    }
  }

  async function handlePrefChange(
    key: 'notifyOnChat' | 'notifyWhenPeopleOnline' | 'notifyOnBuzz' | 'notifyOnStories',
    enabled: boolean,
  ) {
    setPrefBusy((prev) => ({ ...prev, [key]: true }))
    try {
      const updated = await api.updateMe({ [key]: enabled } as Parameters<typeof api.updateMe>[0])
      applyProfile(updated)
      const labels: Record<typeof key, string> = {
        notifyOnChat: 'chat alerts',
        notifyWhenPeopleOnline: 'people coming online alerts',
        notifyOnBuzz: 'Buzz post alerts',
        notifyOnStories: 'Stories alerts',
      }
      toast.success(enabled ? `${labels[key]} turned on.` : `${labels[key]} turned off.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the notification setting.')
    } finally {
      setPrefBusy((prev) => ({ ...prev, [key]: false }))
    }
  }

  async function handleAudienceChange(value: 'anyone' | 'friends') {
    setPrefBusy((prev) => ({ ...prev, onlineNotificationAudience: true }))
    try {
      const updated = await api.updateMe({ onlineNotificationAudience: value })
      applyProfile(updated)
      toast.success(value === 'anyone' ? 'You will be notified about anyone.' : 'You will be notified about friends.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the notification audience.')
    } finally {
      setPrefBusy((prev) => ({ ...prev, onlineNotificationAudience: false }))
    }
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-primary" aria-hidden /> Notifications
        </CardTitle>
        <CardDescription>
          Control which updates you hear about, and keep your device push permission up to date.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-3">
          {view === 'checking' && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Checking notification support…
            </div>
          )}

          {view === 'unsupported' && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>Not available in this browser.</span>
            </div>
          )}

          {view === 'denied' && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-950">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" aria-hidden />
              <span className="flex-1">
                Notifications are blocked for this site. Enable them in your browser's site settings
                (iOS Settings → Safari → Notifications, after installing the app).
              </span>
            </div>
          )}

          {(view === 'default' || view === 'needs-subscription') && (
            <div className="space-y-2">
              <Button onClick={() => void handleEnable()} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <BellRing className="h-4 w-4" aria-hidden />
                )}
                Enable notifications
              </Button>
              <p className="text-[11px] text-muted-foreground">
                {view === 'default'
                  ? 'Your browser will ask for permission. You can turn this off anytime.'
                  : 'Permission is granted, but this device is not registered for push yet. Tap to finish setup.'}
              </p>
            </div>
          )}

          {view === 'granted' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
                  Push notifications
                </span>
                <Badge variant="outline" className="border-emerald-500/50 text-emerald-400">
                  On
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={testing} onClick={() => void handleTest()}>
                  {testing ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <SendHorizontal className="h-4 w-4" aria-hidden />
                  )}
                  Send test
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={busy}
                  onClick={() => void handleDisable()}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Turn off
                </Button>
              </div>
            </div>
          )}

          {view === 'denied' && (
            <div>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void handleEnable()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Try again
              </Button>
            </div>
          )}

          {iosHint && view !== 'granted' && (
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              On iPhone, notifications require Hushly installed on your Home Screen
              (Share → Add to Home Screen).
            </p>
          )}
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Chat</Label>
              <p className="text-[11px] text-muted-foreground">New messages and chats</p>
            </div>
            <Switch
              checked={profile.notifyOnChat}
              disabled={!!prefBusy.notifyOnChat}
              onCheckedChange={(enabled) => void handlePrefChange('notifyOnChat', enabled)}
              aria-label="Toggle chat notifications"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">People coming online</Label>
              <p className="text-[11px] text-muted-foreground">When someone visible comes online</p>
            </div>
            <Switch
              checked={profile.notifyWhenPeopleOnline}
              disabled={!!prefBusy.notifyWhenPeopleOnline}
              onCheckedChange={(enabled) => void handlePrefChange('notifyWhenPeopleOnline', enabled)}
              aria-label="Toggle people coming online notifications"
            />
          </div>

          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-medium">People to notify about</Label>
              <Select
                value={profile.onlineNotificationAudience}
                disabled={!!prefBusy.onlineNotificationAudience}
                onValueChange={(value) => {
                  if (value === 'anyone' || value === 'friends') void handleAudienceChange(value)
                }}
              >
                <SelectTrigger className="w-full max-w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anyone">Anyone</SelectItem>
                  <SelectItem value="friends">Friends</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Friends are people you have saved as contacts.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Buzz</Label>
              <p className="text-[11px] text-muted-foreground">New posts, replies and activity on Buzz</p>
            </div>
            <Switch
              checked={profile.notifyOnBuzz}
              disabled={!!prefBusy.notifyOnBuzz}
              onCheckedChange={(enabled) => void handlePrefChange('notifyOnBuzz', enabled)}
              aria-label="Toggle Buzz notifications"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Stories</Label>
              <p className="text-[11px] text-muted-foreground">New stories shared with you</p>
            </div>
            <Switch
              checked={profile.notifyOnStories}
              disabled={!!prefBusy.notifyOnStories}
              onCheckedChange={(enabled) => void handlePrefChange('notifyOnStories', enabled)}
              aria-label="Toggle story notifications"
            />
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Notifications are delivered per device. Turning them off here only affects this browser.
        </p>
      </CardContent>
    </Card>
  )
}
