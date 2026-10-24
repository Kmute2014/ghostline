"use client";

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion, type Transition } from 'framer-motion'
import {
  Users,
  Search,
  RefreshCw,
  EyeOff,
  MessagesSquare,
  Wifi,
  KeyRound,
  Share2,
  Copy,
  Check,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import type { OnlinePerson } from '@/lib/types'
import { cn } from '@/lib/utils'
import { CodeSearchDialog } from '@/components/screens/code-search-dialog'
import { copyWithToast } from '@/components/screens/profile/profile-bits'

const spring: Transition = { type: 'spring', stiffness: 400, damping: 34 }

/**
 * People — the live online directory. No matching, no queue: everyone who is
 * online (and opted in) is listed in realtime; tap a person to open a chat
 * instantly. Existing conversations re-open instead of duplicating.
 */
export function PeopleScreen() {
  const queryClient = useQueryClient()
  const profile = useAppStore((s) => s.profile)
  const setProfile = useAppStore((s) => s.setProfile)
  const openConversation = useAppStore((s) => s.openConversation)

  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [codeOpen, setCodeOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const people = useQuery({
    queryKey: ['people'],
    queryFn: api.getPeople,
    refetchInterval: 20_000, // safety net; presence pushes refresh this live
  })

  // Share link for the invite card (the code itself comes from the store profile).
  const invite = useQuery({
    queryKey: ['invite'],
    queryFn: api.getInvite,
    enabled: !!profile?.inviteCode,
  })

  async function copyInvite() {
    if (!profile?.inviteCode) return
    const ok = await copyWithToast(profile.inviteCode, 'Invite code copied')
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }

  async function shareInvite() {
    const code = profile?.inviteCode
    if (!code) return
    const shareUrl = invite.data?.shareUrl
    const text = shareUrl
      ? `Add me on Ghostline — my code: ${code} or open ${shareUrl}`
      : `Add me on Ghostline — my code: ${code}`
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Ghostline', text })
        return
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      // Any other share failure falls through to the clipboard fallback.
    }
    await copyWithToast(text, 'Invite copied — paste it anywhere.')
  }

  async function refresh() {
    setRefreshing(true)
    await people.refetch()
    setRefreshing(false)
  }

  async function toggleVisible(next: boolean) {
    if (!profile) return
    const prev = profile.showInPeople
    setProfile({ ...profile, showInPeople: next }) // optimistic
    try {
      const updated = await api.updateMe({ showInPeople: next })
      setProfile(updated)
      queryClient.invalidateQueries({ queryKey: ['session'] })
      toast.success(
        next
          ? 'You are visible in People while online.'
          : 'You are hidden — others can no longer see you in People.'
      )
    } catch (err) {
      setProfile({ ...profile, showInPeople: prev }) // revert
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update visibility.')
    }
  }

  /** One tap = open (or start) the chat. No expiration prompt, no matching. */
  async function openChat(person: OnlinePerson) {
    if (openingId) return
    setOpeningId(person.publicId)
    try {
      if (person.conversationId) {
        openConversation(person.conversationId)
        return
      }
      const res = await api.createConversation(person.publicId, 'never')
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['people'] })
      openConversation(res.conversation.id)
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : `Could not open a chat with ${person.displayName}.`
      )
      queryClient.invalidateQueries({ queryKey: ['people'] })
    } finally {
      setOpeningId(null)
    }
  }

  const users = people.data?.users ?? []
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter((u) => u.displayName.toLowerCase().includes(q))
  }, [users, search])

  const hidden = profile ? !profile.showInPeople : false

  return (
    <div className="flex-1 flex flex-col max-w-2xl w-full mx-auto p-3 gap-2.5">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold tracking-tight flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" aria-hidden /> People
          </h1>
          <p className="text-[11px] text-muted-foreground mt-0.5" aria-live="polite">
            {people.isLoading
              ? 'Checking who is around…'
              : `${users.length} ${users.length === 1 ? 'person' : 'people'} online right now — say hi to anyone ✨`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCodeOpen(true)}
            aria-label="Find someone by invite code"
            title="Find someone by invite code"
          >
            <KeyRound className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={refresh} disabled={refreshing} aria-label="Refresh people list">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Your invite code — tap the card to copy, Share for the deep link */}
      {profile?.inviteCode && (
        <motion.div whileTap={{ scale: 0.98 }} transition={spring}>
          <Card
            className="cursor-pointer select-none hover:border-primary/40 transition-colors"
            role="button"
            tabIndex={0}
            aria-label="Copy your invite code"
            onClick={() => void copyInvite()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void copyInvite()
              }
            }}
          >
            <CardContent className="p-2.5 flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10" aria-hidden>
                <KeyRound className="h-3.5 w-3.5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Invite code · tap to copy
                </p>
                <p className="font-mono text-xs tracking-[0.15em] truncate">{profile.inviteCode}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  void shareInvite()
                }}
                aria-label="Share your invite code"
              >
                <Share2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
              <span className="shrink-0 text-muted-foreground" aria-hidden>
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </span>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Own visibility hint */}
      {hidden && (
        <Card className="border-amber-500/40 bg-amber-500/[0.05]">
          <CardContent className="p-3.5 flex items-center gap-3">
            <EyeOff className="h-4 w-4 text-amber-500 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">You're invisible.</span> You can still see
              and message others, but nobody sees you in this list.
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="people-visible-inline"
                checked={false}
                onCheckedChange={(v) => v && toggleVisible(true)}
                aria-label="Turn on my visibility in People"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      {users.length > 3 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by display name…"
            className="h-9 pl-9"
            aria-label="Search online people"
          />
        </div>
      )}

      {/* List */}
      {people.isLoading ? (
        <div className="grid grid-cols-4 gap-1.5" role="status" aria-label="Loading people">
          {Array.from({ length: 20 }, (_, i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      ) : people.isError ? (
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              {people.error instanceof ApiClientError ? people.error.message : 'Could not load online people.'}
            </p>
            <Button variant="outline" onClick={() => people.refetch()}>Try again</Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            {search ? (
              <>
                <Search className="h-9 w-9 mx-auto text-muted-foreground/60" aria-hidden />
                <p className="text-sm text-muted-foreground">
                  No online person matches “{search}”.
                </p>
              </>
            ) : (
              <>
                <Wifi className="h-9 w-9 mx-auto text-muted-foreground/60" aria-hidden />
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Nobody else is online at the moment. This list updates live — leave the app open
                  and people will appear here as they connect.
                </p>
                {hidden && (
                  <p className="text-xs text-muted-foreground">
                    Tip: with visibility off you stay here alone — flip the switch above to be seen.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <ul className="grid grid-cols-4 gap-1.5 sm:gap-2" aria-label="People online now">
          {filtered.map((u) => (
            <li key={u.publicId}>
              <motion.div whileTap={{ scale: 0.97 }} transition={spring}>
                <Card className="relative h-[68px] overflow-hidden rounded-lg py-1.5 shadow-none hover:border-primary/40 transition-colors">
                  <CardContent className="h-full px-1 py-0">
                    <button
                      className="flex h-full w-full min-w-0 touch-manipulation flex-col items-center justify-center gap-1 text-center"
                      onClick={() => openChat(u)}
                      disabled={openingId === u.publicId}
                      aria-label={`Open chat with ${u.displayName}, online now${u.conversationId ? ', existing conversation' : ''}`}
                    >
                      <UserAvatar
                        displayName={u.displayName}
                        publicId={u.publicId}
                        avatarUrl={u.avatarUrl}
                        online
                        size={34}
                      />
                      <span className="flex w-full min-w-0 items-center justify-center gap-1 text-[11px] font-medium leading-tight">
                        <span className="truncate">{u.displayName}</span>
                        {u.conversationId && (
                          <MessagesSquare className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                      </span>
                    </button>
                  </CardContent>
                </Card>
              </motion.div>
            </li>
          ))}
        </ul>
      )}

      <Label className="sr-only" htmlFor="people-visible-inline">Show me in People</Label>
      <p className="hidden md:flex text-[11px] text-muted-foreground leading-relaxed gap-1.5 mt-auto">
        <Users className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
        <span>
          Everyone here is online right now — presence comes from the server, not the device. Tap a
          person to start chatting instantly; no matching, no waiting. Control your own visibility
          from your Profile.
        </span>
      </p>

      <CodeSearchDialog open={codeOpen} onClose={() => setCodeOpen(false)} />
    </div>
  )
}
