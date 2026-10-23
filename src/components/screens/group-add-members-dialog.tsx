"use client";

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Loader2, Search, UserPlus, UsersRound } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { UserAvatar } from '@/components/shared/user-avatar'
import { api, ApiClientError } from '@/lib/client-api'
import type { OnlinePerson, ContactDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

type Candidate = {
  publicId: string
  displayName: string
  avatarUrl: string | null
  online: boolean
}

const MAX_GROUP_MEMBERS = 30

/**
 * "Invite to group" composer inside an existing group: tick people from the
 * union of your saved contacts and everyone currently online (minus anyone
 * already in the group) and add them as full members. The server announces
 * the additions with a system message and live roster refresh.
 */
export function GroupAddMembersDialog({
  conversationId,
  groupName,
  existingPublicIds,
  open,
  onClose,
}: {
  conversationId: string
  groupName: string
  /** Everyone already in the group, including me. */
  existingPublicIds: string[]
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const people = useQuery({
    queryKey: ['people'],
    queryFn: api.getPeople,
    enabled: open,
  })
  const contacts = useQuery({
    queryKey: ['contacts'],
    queryFn: api.getContacts,
    enabled: open,
  })

  // Every open starts fresh — render-time "adjust state when props change"
  // pattern (same as GroupCreateDialog) to avoid effect-driven cascades.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setSelected(new Set())
      setSearch('')
      setAdding(false)
      setError(null)
    }
  }

  const candidates: Candidate[] = useMemo(() => {
    const existing = new Set(existingPublicIds)
    const byId = new Map<string, Candidate>()
    const push = (c: { publicId: string; displayName: string; avatarUrl: string | null; online: boolean }) => {
      if (existing.has(c.publicId) || byId.has(c.publicId)) return
      byId.set(c.publicId, c)
    }
    ;((contacts.data?.contacts ?? []) as ContactDTO[]).forEach((c) =>
      push({ publicId: c.publicId, displayName: c.nickname ?? c.displayName, avatarUrl: c.avatarUrl, online: c.online })
    )
    ;((people.data?.users ?? []) as OnlinePerson[]).forEach((u) =>
      push({ publicId: u.publicId, displayName: u.displayName, avatarUrl: u.avatarUrl, online: u.online })
    )
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [contacts.data, people.data, existingPublicIds])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => c.displayName.toLowerCase().includes(q))
  }, [candidates, search])

  function toggle(publicId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(publicId)) next.delete(publicId)
      else next.add(publicId)
      return next
    })
  }

  async function add() {
    if (selected.size === 0 || adding) return
    setAdding(true)
    setError(null)
    try {
      const res = await api.addGroupMembers(conversationId, [...selected])
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
      toast.success(
        res.added.length === 1
          ? `${res.added[0]} joined “${groupName}”.`
          : `${res.added.length} people joined “${groupName}”.`
      )
      if (res.skipped.length > 0) {
        toast.warning(`Couldn't add: ${res.skipped.join(', ')} (block active).`)
      }
      onClose()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not add members.')
      setAdding(false)
    }
  }

  const canAdd = selected.size > 0 && !adding

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" aria-hidden /> Invite to “{groupName}”
          </DialogTitle>
          <DialogDescription>
            They become full members instantly — everyone sees a system message in the timeline.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people…"
              className="pl-9"
              aria-label="Search people to invite"
            />
          </div>

          <div className="max-h-64 overflow-y-auto ghostline-scroll rounded-lg border divide-y">
            {people.isLoading || contacts.isLoading ? (
              <div className="p-3 space-y-2.5">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-lg" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                {search
                  ? `No one matches “${search}”.`
                  : 'Everyone you know is already in this group — share the group invite code instead.'}
              </p>
            ) : (
              filtered.map((c) => {
                const checked = selected.has(c.publicId)
                return (
                  <button
                    key={c.publicId}
                    type="button"
                    onClick={() => toggle(c.publicId)}
                    aria-pressed={checked}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/60',
                      checked && 'bg-primary/[0.07]'
                    )}
                  >
                    <UserAvatar
                      displayName={c.displayName}
                      publicId={c.publicId}
                      avatarUrl={c.avatarUrl}
                      online={c.online}
                      size={34}
                    />
                    <span className="min-w-0 flex-1 text-sm font-medium truncate">{c.displayName}</span>
                    <span
                      className={cn(
                        'h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-colors',
                        checked ? 'bg-primary border-primary text-primary-foreground' : 'border-input'
                      )}
                      aria-hidden
                    >
                      {checked && <Check className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                )
              })
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={adding}>
            Cancel
          </Button>
          <Button onClick={() => void add()} disabled={!canAdd}>
            {adding ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <UsersRound className="h-4 w-4" aria-hidden />
            )}
            {adding ? 'Adding…' : `Add${selected.size ? ` (${selected.size})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
