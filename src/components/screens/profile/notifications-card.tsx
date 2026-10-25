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

type PushView = 'checking' | 'unsupported' | 'default' | 'granted' | 'denied'

/**
 * Notifications card for the profile screen: the UI for enabling pop-up push
 * notifications (new-message pings even while Ghostline is closed).
 *
 * Permission state is re-read on mount and whenever the tab becomes visible
 * again — the OS can change it while the app is in the background.
 */
export function NotificationsCard() {
  const [view, setView] = useState<PushView>('checking')
  const [iosHint, setIosHint] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  const refresh = useCallback(() => {
    setIosHint(isIOSDevice() && !isStandalone())
    if (!pushSupported()) {
      setView('unsupported')
      return
    }
    const permission = notificationPermission()
    setView(permission === 'unsupported' ? 'unsupported' : permission)
  }, [])

  // Refresh on mount (permissions can change outside the app).
  useEffect(() => {
    refresh()
  }, [refresh])

  // …and whenever the app returns to the foreground.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  async function handleEnable() {
    setBusy(true)
    try {
      const result = await enablePush() // must run inside the click gesture
      if (result.ok) {
        toast.success("Notifications enabled — you'll get pings even when the app is closed.")
      } else {
        toast.error(result.reason)
      }
    } finally {
      setBusy(false)
      refresh()
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
        toast.warning('No device subscribed yet — enable notifications on a device first.')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the test notification.')
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-primary" aria-hidden /> Chat notifications
        </CardTitle>
        <CardDescription>
          Get a pop-up for new chats and messages — even when Hushly is closed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {view === 'default' && (
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
              Your browser will ask for permission. You can turn this off anytime.
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

        {/* Blocked-state retry: re-runs the flow so the browser's reason surfaces as a toast. */}
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

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Notifications are delivered per device. Turning them off here only affects this browser.
        </p>
      </CardContent>
    </Card>
  )
}

export function OnlineNotificationsCard({
  profile,
  applyProfile,
}: {
  profile: OwnProfile
  applyProfile: (profile: OwnProfile) => void
}) {
  const [busy, setBusy] = useState(false)

  async function handleChange(enabled: boolean) {
    setBusy(true)
    try {
      const updated = await api.updateMe({ notifyWhenPeopleOnline: enabled })
      applyProfile(updated)
      toast.success(enabled ? 'Online notifications enabled.' : 'Online notifications turned off.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update online notifications.')
    } finally {
      setBusy(false)
    }
  }

  async function handleAudienceChange(value: 'anyone' | 'friends') {
    setBusy(true)
    try {
      const updated = await api.updateMe({ onlineNotificationAudience: value })
      applyProfile(updated)
      toast.success(value === 'anyone' ? 'You will be notified about anyone.' : 'You will be notified about friends.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the notification audience.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" aria-hidden /> People coming online
        </CardTitle>
        <CardDescription>
          Get a push notification when someone visible in People comes online.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <Label htmlFor="online-notifications" className="min-w-0 text-sm font-medium">
            Notify me when people come online
          </Label>
          <Switch
            id="online-notifications"
            className="shrink-0"
            checked={profile.notifyWhenPeopleOnline}
            disabled={busy}
            onCheckedChange={(enabled) => void handleChange(enabled)}
            aria-label="Notify me when people come online"
          />
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <Label htmlFor="online-notification-audience" className="min-w-0 text-sm font-medium">
            Notify me about
          </Label>
          <Select
            value={profile.onlineNotificationAudience}
            disabled={busy}
            onValueChange={(value) => {
              if (value === 'anyone' || value === 'friends') void handleAudienceChange(value)
            }}
          >
            <SelectTrigger id="online-notification-audience" className="w-full sm:w-36 sm:shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anyone">Anyone</SelectItem>
              <SelectItem value="friends">Friends</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Friends are people you have saved as contacts. This is separate from chat notifications.
          Push notifications must be enabled on a device to receive alerts.
        </p>
      </CardContent>
    </Card>
  )
}
