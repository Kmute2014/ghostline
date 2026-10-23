"use client";

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Loader2, Search, UsersRound } from 'lucide-react'
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
import { useAppStore } from '@/store/app-store'
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
 * "New group" composer: pick a name, tick members from the union of your
 * saved contacts and everyone currently online, and create the group.
 * Group chats never expire and keep history until deleted.
 */
export function GroupCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const openConversation = useAppStore((s) => s.openConversation)

  const [name, setName] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
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

  // Every open starts fresh — reset via the render-time "adjust state when
  // props change" pattern (React docs) so no effect-driven cascades occur.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setName('')
      setSelected(new Set())
      setSearch('')
      setCreating(false)
      setError(null)
    }
  }

  const candidates: Candidate[] = useMemo(() => {
    const byId = new Map<string, Candidate>()
    const push = (c: { publicId: string; displayName: string; avatarUrl: string | null; online: boolean }) => {
      if (!byId.has(c.publicId)) byId.set(c.publicId, c)
    }
    ;((contacts.data?.contacts ?? []) as ContactDTO[]).forEach((c) =>
      push({ publicId: c.publicId, displayName: c.nickname ?? c.displayName, avatarUrl: c.avatarUrl, online: c.online })
    )
    ;((people.data?.users ?? []) as OnlinePerson[]).forEach((u) =>
      push({ publicId: u.publicId, displayName: u.displayName, avatarUrl: u.avatarUrl, online: u.online })
    )
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [contacts.data, people.data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter((c) => c.displayName.toLowerCase().includes(q))
  }, [candidates, search])

  function toggle(publicId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(publicId)) next.delete(publicId)
      else if (next.size < MAX_GROUP_MEMBERS) next.add(publicId)
      return next
    })
  }

  async function create() {
    const groupName = name.trim()
    if (!groupName || selected.size === 0 || creating) return
    setCreating(true)
    setError(null)
    try {
      const res = await api.createGroup(groupName, [...selected])
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['people'] })
      toast.success(`Group “${groupName}” created.`)
      if (res.skipped.length > 0) {
        toast.warning(`Couldn't add: ${res.skipped.join(', ')} (block active).`)
      }
      openConversation(res.conversation.id)
      onClose()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create the group.')
      setCreating(false)
    }
  }

  const canCreate = name.trim().length > 0 && selected.size > 0 && !creating

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UsersRound className="h-5 w-5 text-primary" aria-hidden /> New group
          </DialogTitle>
          <DialogDescription>
            Groups never expire — history is kept until the group is deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label htmlFor="group-name" className="text-sm font-medium">
              Group name
            </label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "Night riders"'
              maxLength={60}
              autoFocus
              className="mt-1.5"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                Members <span className="text-muted-foreground">({selected.size} selected)</span>
              </p>
            </div>
            <div className="relative mt-1.5">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search people…"
                className="pl-9"
                aria-label="Search people to add"
              />
            </div>
            <div className="mt-2 max-h-64 overflow-y-auto ghostline-scroll rounded-lg border divide-y">
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
                    : 'Nobody is available yet — invite friends with your code from the People tab.'}
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
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!canCreate}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UsersRound className="h-4 w-4" aria-hidden />}
            {creating ? 'Creating…' : `Create group${selected.size ? ` (${selected.size + 1})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
