"use client";

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Users,
  MapPin,
  MapPinOff,
  RefreshCw,
  Radar,
  ShieldQuestion,
  MessageCircle,
  UserRound,
  EyeOff,
  Info,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { ExpirationDialog } from '@/components/shared/expiration-dialog'
import { ReportDialog } from '@/components/shared/report-dialog'
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
import type { NearbyUser, ExpirationPolicyDTO } from '@/lib/types'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { cn } from '@/lib/utils'

const RADIUS_STEPS = [5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000]

function radiusLabel(m: number) {
  return m < 1000 ? `${m} m` : `${m / 1000} km`
}

/** Requests browser geolocation (permission prompt) and shares it. */
export async function shareCurrentLocation(): Promise<{ ok: boolean; error?: string }> {
  if (!('geolocation' in navigator)) return { ok: false, error: 'This browser does not support location.' }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await api.updateLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy)
          resolve({ ok: true })
        } catch (err) {
          resolve({ ok: false, error: err instanceof ApiClientError ? err.message : 'Could not share location.' })
        }
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied. Enable it in your browser settings to use Nearby.'
            : 'Could not determine your location. Try again.'
        resolve({ ok: false, error: msg })
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 }
    )
  })
}

export function NearbyScreen() {
  const queryClient = useQueryClient()
  const profile = useAppStore((s) => s.profile)
  const setProfile = useAppStore((s) => s.setProfile)
  const openConversation = useAppStore((s) => s.openConversation)
  const reduced = useReducedMotion() ?? false

  const listVariants: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.03 } },
  }
  const itemVariants: Variants = {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 8 },
    show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 400, damping: 32 } },
  }

  const [radius, setRadius] = useState<number>(() => {
    if (typeof window === 'undefined') return 1000
    const stored = Number(window.localStorage.getItem('ghostline-radius'))
    return RADIUS_STEPS.includes(stored) ? stored : 1000
  })
  const [refreshing, setRefreshing] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [selected, setSelected] = useState<NearbyUser | null>(null)
  const [chatTarget, setChatTarget] = useState<NearbyUser | null>(null)
  const [reportTarget, setReportTarget] = useState<NearbyUser | null>(null)

  useEffect(() => {
    window.localStorage.setItem('ghostline-radius', String(radius))
  }, [radius])

  const nearby = useQuery({
    queryKey: ['nearby', radius],
    queryFn: () => api.getNearby(radius),
    refetchInterval: 30_000,
    enabled: Boolean(profile?.nearbyVisible),
  })

  async function refresh() {
    setRefreshing(true)
    // Re-share fresh coordinates before each refresh for live accuracy
    if (profile?.nearbyVisible) await shareCurrentLocation()
    await nearby.refetch()
    setRefreshing(false)
  }

  async function enableDiscovery() {
    setEnabling(true)
    try {
      const updated = await api.updateMe({ nearbyVisible: true })
      setProfile(updated)
      const loc = await shareCurrentLocation()
      if (!loc.ok && loc.error) toast.error(loc.error)
      queryClient.invalidateQueries({ queryKey: ['nearby', radius] })
      queryClient.invalidateQueries({ queryKey: ['session'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not enable discovery.')
      const reverted = await api.updateMe({ nearbyVisible: false }).catch(() => null)
      if (reverted) setProfile(reverted)
    } finally {
      setEnabling(false)
    }
  }

  async function disableDiscovery() {
    try {
      await api.disableLocation()
      const updated = await api.updateMe({ nearbyVisible: false })
      setProfile(updated)
      queryClient.setQueryData(['nearby', radius], { users: [], requiresLocation: false })
      toast.success('You are now hidden. Your stored coordinates were deleted.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not pause visibility.')
    }
  }

  async function startChat(policy: ExpirationPolicyDTO) {
    if (!chatTarget) return
    try {
      const res = await api.createConversation(chatTarget.publicId, policy)
      openConversation(res.conversation.id)
      setChatTarget(null)
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not start the chat.')
      setChatTarget(null)
    }
  }

  async function saveContact(user: NearbyUser) {
    try {
      await api.saveContact(user.publicId)
      toast.success(`${user.displayName} saved to your contacts.`)
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not save contact.')
    }
  }

  async function blockUser(user: NearbyUser) {
    try {
      await api.blockUser(user.publicId)
      toast.success(`${user.displayName} is blocked.`)
      setSelected(null)
      nearby.refetch()
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not block user.')
    }
  }

  const users = nearby.data?.users ?? []

  return (
    <div className="flex-1 flex flex-col max-w-2xl w-full mx-auto p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" aria-hidden /> Nearby
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {profile?.nearbyVisible
              ? 'Visible on Nearby · you can pause anytime ✨'
              : 'Discovery is off — you are invisible'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {profile?.nearbyVisible && (
            <Button variant="outline" size="icon" onClick={refresh} disabled={refreshing} aria-label="Refresh nearby">
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
          )}
        </div>
      </div>

      {!profile?.nearbyVisible ? (
        <Card>
          <CardContent className="p-6 text-center space-y-4">
            <MapPinOff className="h-10 w-10 mx-auto text-muted-foreground" aria-hidden />
            <div className="space-y-1.5">
              <h2 className="font-semibold">Find your people nearby 🌍</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Hushly will ask for your location only now. Others see an <strong>approximate distance</strong> —
                never your coordinates — and only while you stay visible. Turning discovery off deletes your
                stored position immediately.
              </p>
            </div>
            <Button onClick={enableDiscovery} disabled={enabling} size="lg" className="w-full sm:w-auto">
              {enabling ? 'Asking for permission…' : 'Enable Nearby discovery'}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Radius selector */}
          <div className="flex flex-wrap items-center gap-1.5">
            {RADIUS_STEPS.filter((r) => r !== 250 && r !== 2000).map((r) => (
              <motion.button
                key={r}
                onClick={() => setRadius(r)}
                whileTap={reduced ? undefined : { scale: 0.94 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors min-h-[32px]',
                  radius === r
                    ? 'border-primary bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:border-border hover:text-foreground'
                )}
              >
                {radiusLabel(r)}
              </motion.button>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <motion.button
                  whileTap={reduced ? undefined : { scale: 0.94 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors min-h-[32px]',
                    !RADIUS_STEPS.slice(0, 8).includes(radius)
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  Custom
                </motion.button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <p className="text-sm font-medium mb-1">Search radius</p>
                <p className="text-xs text-muted-foreground mb-3">{radiusLabel(radius)}</p>
                <Slider
                  value={[RADIUS_STEPS.indexOf(radius) === -1 ? 9 : RADIUS_STEPS.indexOf(radius)]}
                  min={0}
                  max={RADIUS_STEPS.length - 1}
                  step={1}
                  onValueChange={([idx]) => setRadius(RADIUS_STEPS[idx])}
                />
                <p className="mt-3 text-[11px] text-muted-foreground flex gap-1.5">
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
                  Very small radii (5–25 m) depend on your device's GPS accuracy and can be unreliable
                  indoors.
                </p>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="sm"
              onClick={disableDiscovery}
              className="ml-auto text-muted-foreground gap-1.5"
            >
              <EyeOff className="h-4 w-4" /> Pause visibility
            </Button>
          </div>

          {/* Results */}
          {nearby.isLoading ? (
            <div className="space-y-2.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
              ))}
            </div>
          ) : nearby.isError ? (
            <Card>
              <CardContent className="p-6 text-center space-y-3">
                <p className="text-sm text-muted-foreground">
                  {nearby.error instanceof ApiClientError ? nearby.error.message : 'Could not load nearby people.'}
                </p>
                <Button variant="outline" onClick={() => nearby.refetch()}>Try again</Button>
              </CardContent>
            </Card>
          ) : nearby.data?.requiresLocation ? (
            <Card>
              <CardContent className="p-6 text-center space-y-3">
                <MapPin className="h-8 w-8 mx-auto text-amber-500" aria-hidden />
                <p className="text-sm text-muted-foreground">
                  We need a fresh position to search. Share your location to see who is around.
                </p>
                <Button onClick={() => refresh()} disabled={refreshing}>
                  {refreshing ? 'Sharing…' : 'Share my location'}
                </Button>
              </CardContent>
            </Card>
          ) : users.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center space-y-3">
                <Radar className="h-10 w-10 mx-auto text-muted-foreground/60" aria-hidden />
                <p className="text-sm text-muted-foreground">
                  Nobody is within {radiusLabel(radius)} right now. Try a wider radius — or come back
                  later; this updates automatically.
                </p>
              </CardContent>
            </Card>
          ) : (
            <motion.ul
              className="space-y-2.5"
              aria-label="People nearby"
              variants={listVariants}
              initial="hidden"
              animate="show"
            >
              {users.map((u) => (
                <motion.li key={u.publicId} variants={itemVariants}>
                  <Card className="hover:border-primary/40 transition-colors">
                    <CardContent className="p-3.5 flex items-center gap-3">
                      <motion.button
                        className="flex items-center gap-3 flex-1 min-w-0 text-left"
                        onClick={() => setSelected(u)}
                        whileTap={reduced ? undefined : { scale: 0.985 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        aria-label={`View ${u.displayName}'s profile`}
                      >
                        <UserAvatar displayName={u.displayName} publicId={u.publicId} avatarUrl={u.avatarUrl} online size={44} />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{u.displayName}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" aria-hidden /> ≈ {u.distanceLabel} away · online
                          </p>
                        </div>
                      </motion.button>
                      <Button size="sm" variant="secondary" onClick={() => setChatTarget(u)} className="shrink-0">
                        <MessageCircle className="h-4 w-4 mr-1" aria-hidden /> Chat
                      </Button>
                    </CardContent>
                  </Card>
                </motion.li>
              ))}
            </motion.ul>
          )}

          <p className="text-[11px] text-muted-foreground leading-relaxed flex gap-1.5">
            <ShieldQuestion className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
            Distances are approximate and rounded. Hushly never shows anyone's exact position and
            cannot track movement. You appear here only while visibility is on and your app is open.
          </p>
        </>
      )}

      {/* Profile sheet */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="bottom" className="rounded-t-2xl">
          {selected && (
            <div className="space-y-4 pb-4">
              <SheetHeader className="text-left p-0">
                <div className="flex items-center gap-3">
                  <UserAvatar
                    displayName={selected.displayName}
                    publicId={selected.publicId}
                    avatarUrl={selected.avatarUrl}
                    online
                    size={56}
                  />
                  <div>
                    <SheetTitle>{selected.displayName}</SheetTitle>
                    <SheetDescription className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" /> ≈ {selected.distanceLabel} · online now
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => { setChatTarget(selected); setSelected(null) }}>
                  <MessageCircle className="h-4 w-4 mr-1.5" /> Start chat
                </Button>
                <Button size="sm" variant="secondary" onClick={() => saveContact(selected)}>
                  <UserRound className="h-4 w-4 mr-1.5" /> Save contact
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => { setReportTarget(selected); setSelected(null) }}
                >
                  Report
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="ghost" className="text-destructive">Block</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Block {selected.displayName}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        They will disappear from your Nearby results, cannot match or message you, and
                        cannot use your invite code. You can unblock later in Profile.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => blockUser(selected)}>Block</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <p className="text-xs text-muted-foreground">Anonymous ID: {selected.publicId}</p>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Choose expiration then create */}
      <ExpirationDialog
        open={!!chatTarget}
        onOpenChange={(open) => !open && setChatTarget(null)}
        title={`Start a chat with ${chatTarget?.displayName ?? ''}`}
        description="Pick how long this conversation should live. This applies for both of you."
        busy={false}
        onConfirm={(policy) => startChat(policy)}
      />

      <ReportDialog
        open={!!reportTarget}
        onOpenChange={(open) => !open && setReportTarget(null)}
        publicId={reportTarget?.publicId}
        label={reportTarget?.displayName}
        onBlockedOptional={() => reportTarget && blockUser(reportTarget)}
      />
    </div>
  )
}
