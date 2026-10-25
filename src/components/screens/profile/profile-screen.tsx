"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { format } from 'date-fns'
import {
  CalendarDays,
  Camera,
  Check,
  Download,
  Eye,
  EyeOff,
  Fingerprint,
  Loader2,
  MapPin,
  RefreshCw,
  Share2,
  ShieldCheck,
  Smartphone,
  Trash2,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { ContactsCard } from './contacts-card'
import { BlockedUsersCard } from './blocked-card'
import { NotificationsCard } from './notifications-card'
import { CodeRow, copyWithToast, relativeTime } from './profile-bits'
import type { OwnProfile } from '@/lib/types'

// Mirrors the server-side display-name rule (see /api/me PATCH).
const NAME_RE = /^[\p{L}\p{N} _.'-]{2,24}$/u
const AVATAR_MAX_BYTES = 4 * 1024 * 1024

type ApplyProfile = (profile: OwnProfile) => void

/** Promisified geolocation with high accuracy. */
function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('GEO_UNSUPPORTED'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) reject(new Error('GEO_DENIED'))
        else reject(new Error('GEO_ERROR'))
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    )
  })
}

// ─── Identity ────────────────────────────────────────────────────────────────

function IdentityCard({ profile, applyProfile }: { profile: OwnProfile; applyProfile: ApplyProfile }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [nameDraft, setNameDraft] = useState(profile.displayName)
  const [savingName, setSavingName] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)

  useEffect(() => {
    setNameDraft(profile.displayName)
  }, [profile.displayName])

  const cleanedName = nameDraft.trim().replace(/\s+/g, ' ')
  const nameDirty = cleanedName !== profile.displayName
  const nameValid = NAME_RE.test(cleanedName)

  async function saveName() {
    if (!nameValid) return
    setSavingName(true)
    try {
      const updated = await api.updateMe({ displayName: cleanedName })
      applyProfile(updated)
      toast.success('Display name updated.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update your display name.')
    } finally {
      setSavingName(false)
    }
  }

  async function onAvatarPicked(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Avatars must be image files.')
      return
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error('That image is too large. The maximum is 4 MB.')
      return
    }
    setUploadingAvatar(true)
    try {
      const uploaded = await api.upload(file, 'avatar')
      const updated = await api.updateMe({ avatarFileId: uploaded.id })
      applyProfile(updated)
      toast.success('Avatar updated.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update your avatar.')
    } finally {
      setUploadingAvatar(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-primary" aria-hidden /> Identity
        </CardTitle>
        <CardDescription>How you appear to others on Hushly. No email, no phone number.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-4">
          <UserAvatar
            displayName={profile.displayName}
            publicId={profile.publicId}
            avatarUrl={profile.avatarUrl}
            size={72}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="truncate text-lg font-semibold leading-tight">{profile.displayName}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" aria-hidden />
              Member since {format(new Date(profile.createdAt), 'd MMM yyyy')}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={uploadingAvatar}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAvatar ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Camera className="h-4 w-4" aria-hidden />
              )}
              {profile.avatarUrl ? 'Change avatar' : 'Add avatar'}
            </Button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void onAvatarPicked(e)}
        />

        <Separator />

        <div className="space-y-1.5">
          <Label htmlFor="display-name">Display name</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <Input
                id="display-name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                maxLength={24}
                autoComplete="off"
              />
            </div>
            <Button
              className="w-full shrink-0 sm:w-auto"
              onClick={() => void saveName()}
              disabled={!nameDirty || !nameValid || savingName}
            >
              {savingName ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {nameDirty && !nameValid
              ? '2–24 characters. Letters, numbers, spaces and _ . ’ - are allowed.'
              : `2–24 characters · ${nameDraft.length}/24`}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Public ID</Label>
          <CodeRow value={profile.publicId} copyLabel="Public ID copied" />
          <p className="text-xs text-muted-foreground">
            A stable identifier others see when you interact. It never reveals who you are.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Identity recovery ───────────────────────────────────────────────────────

const RECOVERY_MASK = '•••••-•••••-•••••'

function RecoveryCard({ profile }: { profile: OwnProfile }) {
  const [revealed, setRevealed] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-primary" aria-hidden /> Identity recovery
        </CardTitle>
        <CardDescription>
          Use this code to restore your identity on a new browser or device.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm tracking-[0.2em]">
            {revealed ? profile.recoveryCode : RECOVERY_MASK}
          </code>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Hide recovery code' : 'Reveal recovery code'}
          >
            {revealed ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            onClick={() => void copyWithToast(profile.recoveryCode, 'Recovery code copied')}
          >
            Copy
          </Button>
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-950">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" aria-hidden />
          <span>
            If this browser’s storage is cleared, this code is the only way to restore your identity.
            Store it somewhere safe.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Invite code ─────────────────────────────────────────────────────────────

function InviteCard({ profile, applyProfile }: { profile: OwnProfile; applyProfile: ApplyProfile }) {
  const queryClient = useQueryClient()
  const inviteQuery = useQuery({ queryKey: ['invite'], queryFn: api.getInvite, staleTime: 60_000 })
  const [rotating, setRotating] = useState(false)

  const inviteCode = inviteQuery.data?.inviteCode ?? profile.inviteCode
  const shareUrl =
    inviteQuery.data?.shareUrl ?? `${typeof window === 'undefined' ? '' : window.location.origin}/?invite=${inviteCode}`

  async function shareInvite() {
    const text = `Find me on Hushly with my invite code ${inviteCode}.`
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Hushly', text, url: shareUrl })
        return
      } catch (err) {
        // User dismissed the share sheet — do not fall through to copying.
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    await copyWithToast(shareUrl, 'Invite link copied')
  }

  async function rotateInvite() {
    setRotating(true)
    try {
      await api.rotateInvite()
      await queryClient.invalidateQueries({ queryKey: ['invite'] })
      const me = await api.getMe()
      applyProfile(me)
      toast.success('Invite code rotated. Old links no longer work.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not rotate your invite code.')
    } finally {
      setRotating(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Share2 className="h-4 w-4 text-primary" aria-hidden /> Invite code
        </CardTitle>
        <CardDescription>
          Anyone with this link can start a conversation with you directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>Code</Label>
          <CodeRow
            value={inviteCode}
            copyLabel="Invite code copied"
            className="justify-center py-3"
            actions={
              <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => void shareInvite()}>
                <Share2 className="h-3.5 w-3.5" aria-hidden />
                Share
              </Button>
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label>Share link</Label>
          <CodeRow value={shareUrl} copyLabel="Invite link copied" />
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={rotating}>
              {rotating ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden />
              )}
              Rotate code
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Rotate your invite code?</AlertDialogTitle>
              <AlertDialogDescription>
                Your current code and share link stop working immediately — anyone holding the old
                link will no longer be able to reach you. Conversations already started are
                unaffected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void rotateInvite()}>Rotate code</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

// ─── Discovery & privacy ─────────────────────────────────────────────────────

type PermissionView = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'checking'

function PermissionBadge({ state }: { state: PermissionView }) {
  const map: Record<PermissionView, { label: string; className: string }> = {
    granted: { label: 'Granted', className: 'border-emerald-500/50 text-emerald-400' },
    prompt: { label: 'Not asked yet', className: 'border-amber-600/60 text-amber-800' },
    denied: { label: 'Denied', className: 'border-destructive/50 text-destructive' },
    unsupported: { label: 'Unavailable', className: 'text-muted-foreground' },
    checking: { label: 'Checking…', className: 'text-muted-foreground' },
  }
  const view = map[state]
  return (
    <Badge variant="outline" className={view.className}>
      {view.label}
    </Badge>
  )
}

function DiscoveryCard({ profile, applyProfile }: { profile: OwnProfile; applyProfile: ApplyProfile }) {
  const queryClient = useQueryClient()
  const [nearbyLocal, setNearbyLocal] = useState(profile.nearbyVisible)
  const [locationBusy, setLocationBusy] = useState(false)
  const [randomLocal, setRandomLocal] = useState(profile.showInPeople)
  const [randomBusy, setRandomBusy] = useState(false)
  const [audience, setAudience] = useState<'public' | 'friends'>(profile.defaultStoryAudience)
  const [audienceBusy, setAudienceBusy] = useState(false)
  const [permission, setPermission] = useState<PermissionView>('checking')

  useEffect(() => setNearbyLocal(profile.nearbyVisible), [profile.nearbyVisible])
  useEffect(() => setRandomLocal(profile.showInPeople), [profile.showInPeople])
  useEffect(() => setAudience(profile.defaultStoryAudience), [profile.defaultStoryAudience])

  // Live location-permission status (where the browser supports it).
  useEffect(() => {
    let cancelled = false
    let status: PermissionStatus | null = null
    const onChange = () => {
      if (!cancelled && status) setPermission(status.state as PermissionView)
    }
    async function check() {
      try {
        if (!navigator.permissions?.query) {
          setPermission('unsupported')
          return
        }
        status = await navigator.permissions.query({ name: 'geolocation' })
        if (cancelled) return
        onChange()
        status.addEventListener('change', onChange)
      } catch {
        if (!cancelled) setPermission('unsupported')
      }
    }
    void check()
    return () => {
      cancelled = true
      status?.removeEventListener('change', onChange)
    }
  }, [])

  async function handleNearbyChange(next: boolean) {
    if (locationBusy) return
    setLocationBusy(true)
    if (next) {
      setNearbyLocal(true) // optimistic; revert on failure
      try {
        const position = await getCurrentPosition()
        const updated = await api.updateMe({ nearbyVisible: true })
        applyProfile(updated)
        try {
          await api.updateLocation(
            position.coords.latitude,
            position.coords.longitude,
            position.coords.accuracy,
          )
          await queryClient.invalidateQueries({ queryKey: ['me'] })
        } catch {
          // Visibility is on; the first coordinate ping can be retried later.
        }
        toast.success('You are now visible on the nearby radar.')
      } catch (err) {
        setNearbyLocal(false)
        if (err instanceof Error && err.message === 'GEO_DENIED') {
          toast.error(
            'Location permission was denied. Allow location access in your browser settings to appear on the radar.',
            { duration: 7000 },
          )
        } else if (err instanceof ApiClientError) {
          toast.error(err.message)
        } else {
          toast.error('Could not get your location. Make sure location services are on.')
        }
      } finally {
        setLocationBusy(false)
      }
    } else {
      setNearbyLocal(false)
      try {
        await api.disableLocation()
        const updated = await api.updateMe({ nearbyVisible: false })
        applyProfile(updated)
        await queryClient.invalidateQueries({ queryKey: ['me'] })
        toast.success('Nearby visibility turned off. Your stored coordinates were deleted.')
      } catch (err) {
        setNearbyLocal(true)
        toast.error(err instanceof ApiClientError ? err.message : 'Could not update nearby visibility.')
      } finally {
        setLocationBusy(false)
      }
    }
  }

  async function handlePeopleVisibilityChange(next: boolean) {
    setRandomBusy(true)
    setRandomLocal(next)
    try {
      const updated = await api.updateMe({ showInPeople: next })
      applyProfile(updated)
      toast.success(
        next ? 'You are visible in People.' : 'You are hidden from People.'
      )
    } catch (err) {
      setRandomLocal(!next)
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update People visibility.')
    } finally {
      setRandomBusy(false)
    }
  }

  async function handleAudienceChange(value: string) {
    const next: 'public' | 'friends' = value === 'friends' ? 'friends' : 'public'
    setAudienceBusy(true)
    setAudience(next)
    try {
      const updated = await api.updateMe({ defaultStoryAudience: next })
      applyProfile(updated)
      toast.success(next === 'friends' ? 'Stories default to friends only.' : 'Stories default to public.')
    } catch (err) {
      setAudience(profile.defaultStoryAudience)
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update the default audience.')
    } finally {
      setAudienceBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-4 w-4 text-primary" aria-hidden /> Discovery &amp; privacy
        </CardTitle>
        <CardDescription>Control how other people can find and reach you.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Nearby visibility */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="nearby-visible">Nearby visibility</Label>
            <p className="text-xs text-muted-foreground">
              Appear on the nearby radar for people within range of you.
            </p>
          </div>
          <Switch
            id="nearby-visible"
            checked={nearbyLocal}
            disabled={locationBusy}
            onCheckedChange={(v) => void handleNearbyChange(v)}
          />
        </div>

        <div className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Location permission</span>
            <PermissionBadge state={permission} />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Coordinates last shared</span>
            <span className={profile.locationUpdatedAt ? '' : 'text-muted-foreground'}>
              {profile.locationUpdatedAt ? relativeTime(profile.locationUpdatedAt) : 'Never shared'}
            </span>
          </div>
        </div>

        <Separator />

        {/* People directory visibility */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="random-chat">Show me in People</Label>
            <p className="text-xs text-muted-foreground">
              Appear in the online People directory while you're online. Turning this off doesn't
              affect existing chats or your invite code.
            </p>
          </div>
          <Switch
            id="random-chat"
            checked={randomLocal}
            disabled={randomBusy}
            onCheckedChange={(v) => void handlePeopleVisibilityChange(v)}
          />
        </div>

        <Separator />

        {/* Default story audience */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="story-audience">Default story audience</Label>
            <p className="text-xs text-muted-foreground">Pre-selected when you post a new story.</p>
          </div>
          <Select value={audience} onValueChange={(v) => void handleAudienceChange(v)} disabled={audienceBusy}>
            <SelectTrigger id="story-audience" className="w-40 shrink-0 sm:w-48" aria-label="Default story audience">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="friends">Friends only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Others only ever see approximate distances, rounded to 10, 25 or 100 m buckets — your
            exact coordinates are never shared. GPS accuracy depends on your device: a 5 m radius
            can be unreliable indoors.
          </span>
        </p>
      </CardContent>
    </Card>
  )
}

// ─── Danger zone ─────────────────────────────────────────────────────────────

/**
 * Manual entry point to the Add-to-Home-Screen popup (auto-triggers live in
 * AppRoot). Hidden once the app is actually running installed/standalone.
 */
function InstallCard() {
  const setInstallPromptOpen = useAppStore((s) => s.setInstallPromptOpen)
  const [installed] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(display-mode: standalone)').matches ||
        (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
        window.localStorage.getItem('gl-pwa-installed') === '1'
      : false,
  )
  if (installed) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-primary" aria-hidden />
          Get the app
        </CardTitle>
        <CardDescription>
          Add Hushly to your home screen for the full-screen experience and instant message
          alerts. Works on iPhone (via Safari share menu) and Android.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={() => setInstallPromptOpen(true)} className="w-full sm:w-auto">
          <Download className="h-4 w-4" aria-hidden />
          Install app
        </Button>
      </CardContent>
    </Card>
  )
}

function DangerZoneCard() {
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  async function deleteAccount() {
    if (confirmText !== 'DELETE') return
    setDeleting(true)
    try {
      await api.deleteAccount()
      toast.success('Identity deleted.')
      window.location.reload()
    } catch (err) {
      setDeleting(false)
      toast.error(err instanceof ApiClientError ? err.message : 'Could not delete your identity.')
    }
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <Trash2 className="h-4 w-4" aria-hidden /> Danger zone
        </CardTitle>
        <CardDescription>Irreversible actions for this anonymous identity.</CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete this anonymous identity
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this anonymous identity?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently erases your profile, messages, stories and saved contacts.
                Conversations are removed for the other person too. There is no way back — not even
                with your recovery code.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="delete-confirm">
                Type <span className="font-mono font-semibold">DELETE</span> to confirm
              </Label>
              <Input
                id="delete-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                autoFocus
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => {
                  setConfirmText('')
                }}
              >
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={confirmText !== 'DELETE' || deleting}
                onClick={(e) => {
                  e.preventDefault()
                  void deleteAccount()
                }}
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Delete forever
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export function ProfileScreen() {
  const { profile, setProfile } = useAppStore()
  const queryClient = useQueryClient()

  // Refresh own profile; the store is the render source, the query keeps it fresh.
  const meQuery = useQuery({ queryKey: ['me'], queryFn: api.getMe, staleTime: 30_000 })

  useEffect(() => {
    if (meQuery.data) setProfile(meQuery.data)
  }, [meQuery.data, setProfile])

  const applyProfile = useCallback<ApplyProfile>(
    (updated) => {
      setProfile(updated)
      void queryClient.invalidateQueries({ queryKey: ['session'] })
    },
    [queryClient, setProfile],
  )

  if (!profile) return null

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 pb-24 sm:px-6 md:py-10">
      <header className="mb-8 flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between md:mb-10">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Your account
          </p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Profile &amp; privacy</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Manage how you appear, who can find you, and how to keep your identity safe.
          </p>
        </div>
        <div className="inline-flex w-fit items-center gap-2 rounded-full border bg-card/70 px-3 py-2 text-xs font-medium text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden />
          Anonymous by design
        </div>
      </header>

      <div className="space-y-10 md:space-y-12">
        <section aria-labelledby="profile-identity-heading">
          <div className="mb-4">
            <h2 id="profile-identity-heading" className="text-lg font-semibold tracking-tight">
              Identity &amp; access
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Update how people recognize you and protect access to your account.
            </p>
          </div>
          <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
            <IdentityCard profile={profile} applyProfile={applyProfile} />
            <RecoveryCard profile={profile} />
            <InviteCard profile={profile} applyProfile={applyProfile} />
          </div>
        </section>

        <section aria-labelledby="profile-privacy-heading">
          <div className="mb-4">
            <h2 id="profile-privacy-heading" className="text-lg font-semibold tracking-tight">
              Privacy &amp; connections
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose how you show up and manage the people in your circle.
            </p>
          </div>
          <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
            <div className="md:col-span-2">
              <DiscoveryCard profile={profile} applyProfile={applyProfile} />
            </div>
            <ContactsCard />
            <BlockedUsersCard />
          </div>
        </section>

        <section aria-labelledby="profile-app-heading">
          <div className="mb-4">
            <h2 id="profile-app-heading" className="text-lg font-semibold tracking-tight">
              App &amp; notifications
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose how Hushly keeps you connected on this device.
            </p>
          </div>
          <div className="grid items-start gap-4 md:grid-cols-2 md:gap-5">
            <NotificationsCard />
            <InstallCard />
          </div>
        </section>

        <section aria-labelledby="profile-account-heading">
          <div className="mb-4">
            <h2 id="profile-account-heading" className="text-lg font-semibold tracking-tight">
              Account
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Permanently remove this identity and its data.
            </p>
          </div>
          <DangerZoneCard />
        </section>
      </div>
    </div>
  )
}

export default ProfileScreen
