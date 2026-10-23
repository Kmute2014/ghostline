"use client";

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Shuffle, Search, X, MessagesSquare, Radar, UserX } from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ReportDialog } from '@/components/shared/report-dialog'
import type { ConversationSummary } from '@/lib/types'

export function RandomChatScreen() {
  const queryClient = useQueryClient()
  const { profile, setProfile, openConversation, socketConnected } = useAppStore()
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [reportOpen, setReportOpen] = useState(false)
  const [randomConv, setRandomConv] = useState<ConversationSummary | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Existing active random conversation?
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: api.getConversations,
    refetchInterval: searching ? 4_000 : 30_000,
    enabled: Boolean(profile),
  })

  useEffect(() => {
    const active = (conversations.data?.conversations ?? []).find((c) => c.type === 'random')
    setRandomConv(active ?? null)
  }, [conversations.data])

  // Search state follows the server (source of truth), with socket as the fast path
  const matchState = useQuery({
    queryKey: ['match'],
    queryFn: api.matchState,
    refetchInterval: searching ? 5_000 : false,
    enabled: Boolean(profile),
  })

  useEffect(() => {
    if (matchState.data) setSearching(matchState.data.searching)
  }, [matchState.data])

  useEffect(() => {
    if (searching) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } else {
      setElapsed(0)
      if (timerRef.current) clearInterval(timerRef.current)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [searching])

  async function toggleAvailability(v: boolean) {
    try {
      const updated = await api.updateMe({ randomChatAvailable: v })
      setProfile(updated)
      queryClient.invalidateQueries({ queryKey: ['match'] })
      toast.success(
        v ? 'You are visible for random chats.' : 'Random chat is off. Existing chats are unaffected.'
      )
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update availability.')
    }
  }

  async function startSearch() {
    setBusy(true)
    try {
      const res = await api.startMatch()
      if (res.status === 'matched') {
        setSearching(false)
        openConversation(res.conversationId)
      } else {
        setSearching(true)
      }
      queryClient.invalidateQueries({ queryKey: ['match'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not start searching.')
    } finally {
      setBusy(false)
    }
  }

  async function cancelSearch() {
    try {
      await api.cancelMatch()
      setSearching(false)
      queryClient.invalidateQueries({ queryKey: ['match'] })
    } catch {
      toast.error('Could not cancel the search.')
    }
  }

  async function endAndFindAnother() {
    if (!randomConv) return
    setBusy(true)
    try {
      await api.updateConversation(randomConv.id, { end: true })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      const res = await api.startMatch()
      if (res.status === 'matched') {
        openConversation(res.conversationId)
      } else {
        setSearching(true)
      }
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not find another match.')
    } finally {
      setBusy(false)
    }
  }

  async function endConversation() {
    if (!randomConv) return
    setBusy(true)
    try {
      await api.updateConversation(randomConv.id, { end: true })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      toast.success('Conversation ended.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not end the conversation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col max-w-2xl w-full mx-auto p-4 gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Shuffle className="h-5 w-5 text-primary" aria-hidden /> Random Chat
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Get matched with someone who is online right now. No location needed.
        </p>
      </div>

      {/* Availability toggle */}
      <Card>
        <CardContent className="p-4 flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <Label htmlFor="random-available" className="text-sm font-medium">
              Available for random chat
            </Label>
            <p className="text-xs text-muted-foreground leading-relaxed">
              When off you leave the matching queue. Existing conversations and invite-code chats keep
              working — turning this off never blocks anyone.
            </p>
          </div>
          <Switch
            id="random-available"
            checked={profile?.randomChatAvailable ?? false}
            onCheckedChange={toggleAvailability}
            disabled={!profile}
          />
        </CardContent>
      </Card>

      {!profile ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : randomConv ? (
        /* ── Active random match ── */
        <Card className="border-primary/40">
          <CardContent className="p-6 space-y-4 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center">
              <MessagesSquare className="h-7 w-7 text-primary" aria-hidden />
            </div>
            <div>
              <h2 className="font-semibold">You are in a random chat</h2>
              <p className="text-sm text-muted-foreground mt-1">
                With{' '}
                <strong>{randomConv.other.nickname ?? randomConv.other.displayName}</strong> ·{' '}
                {randomConv.other.online ? 'online now' : 'offline'}
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => openConversation(randomConv.id)}>
                <MessagesSquare className="h-4 w-4 mr-1.5" /> Open chat
              </Button>
              <Button variant="secondary" onClick={endAndFindAnother} disabled={busy}>
                <Shuffle className="h-4 w-4 mr-1.5" /> Skip & find another
              </Button>
              <Button variant="ghost" onClick={endConversation} disabled={busy}>
                End conversation
              </Button>
              <Button variant="ghost" className="text-muted-foreground" onClick={() => setReportOpen(true)}>
                Report
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : searching ? (
        /* ── Searching ── */
        <Card className="overflow-hidden">
          <CardContent className="p-8 space-y-5 text-center relative">
            <div className="relative mx-auto w-24 h-24">
              <div className="absolute inset-0 rounded-full border border-primary/30" />
              <div className="absolute inset-3 rounded-full border border-primary/20" />
              <div className="absolute inset-6 rounded-full border border-primary/10" />
              <Radar
                className="absolute inset-0 m-auto h-8 w-8 text-primary radar-sweep"
                aria-hidden
              />
            </div>
            <div className="space-y-1">
              <h2 className="font-semibold">Looking for someone…</h2>
              <p className="text-xs text-muted-foreground">
                Searching for {elapsed}s · you can keep this tab open
              </p>
            </div>
            <Button variant="outline" onClick={cancelSearch}>
              <X className="h-4 w-4 mr-1.5" /> Cancel search
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* ── Idle ── */
        <Card>
          <CardContent className="p-8 space-y-5 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/15 flex items-center justify-center">
              <Search className="h-7 w-7 text-primary" aria-hidden />
            </div>
            <div className="space-y-1.5">
              <h2 className="font-semibold">Meet a stranger</h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto">
                We pair you with another available user who is online. Matches are atomic — one person,
                one chat. Random chats default to a 24-hour lifetime; either of you can change that in
                chat settings.
              </p>
              {!socketConnected && (
                <p className="text-xs text-amber-500">Realtime is reconnecting — matching still works.</p>
              )}
            </div>
            <Button
              size="lg"
              className="w-full sm:w-auto"
              onClick={startSearch}
              disabled={busy || !profile.randomChatAvailable}
            >
              {busy ? 'Connecting…' : profile.randomChatAvailable ? 'Start searching' : 'Go available first'}
            </Button>
            {!profile.randomChatAvailable && (
              <p className="text-xs text-muted-foreground flex items-center justify-center gap-1.5">
                <UserX className="h-3.5 w-3.5" /> Flip the availability switch above to join the queue.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Matching never pairs blocked users, unavailable users or people already in an active random
        chat. If something feels off, use Skip to move on, or Block and Report — reports go to human
        moderators.
      </p>

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        publicId={randomConv?.other.publicId}
        conversationId={randomConv?.id}
        label={randomConv?.other.displayName}
      />
    </div>
  )
}
