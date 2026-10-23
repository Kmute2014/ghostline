"use client";

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleDashed, Plus, RefreshCw, WifiOff } from 'lucide-react'
import { api } from '@/lib/client-api'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { StoryGroup } from '@/lib/types'
import { StoryComposer } from './story-composer'
import { StoryViewer } from './story-viewer'

/**
 * Stories screen: horizontal tray of story groups (own first), a composer
 * dialog and the full-screen viewer. Data refreshes every 60 s.
 */
export function StoriesScreen() {
  const queryClient = useQueryClient()
  const storiesQuery = useQuery({
    queryKey: ['stories'],
    queryFn: api.getStories,
    refetchInterval: 60_000,
  })

  const [composerOpen, setComposerOpen] = useState(false)
  const [viewer, setViewer] = useState<{ group: StoryGroup; startIndex: number } | null>(null)

  const groups = storiesQuery.data?.groups ?? []
  // Defensive ordering (server already does this): own first, unseen before seen.
  const sorted = [...groups].sort((a, b) => {
    if (a.owner.isOwn !== b.owner.isOwn) return a.owner.isOwn ? -1 : 1
    if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1
    return 0
  })
  const ownGroup = sorted.find((g) => g.owner.isOwn)
  const otherGroups = sorted.filter((g) => !g.owner.isOwn)

  function openGroup(group: StoryGroup) {
    const firstUnseen = group.stories.findIndex((s) => !s.viewedByMe)
    setViewer({ group, startIndex: firstUnseen >= 0 ? firstUnseen : 0 })
  }

  function closeViewer() {
    setViewer(null)
    // Refresh seen rings / view counts after the immersive session.
    queryClient.invalidateQueries({ queryKey: ['stories'] })
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Stories</h1>
          <p className="text-xs text-muted-foreground">
            Moments that vanish 24 hours after being shared.
          </p>
        </div>
        <Button onClick={() => setComposerOpen(true)} className="min-h-[44px] shrink-0">
          <Plus className="h-4 w-4" aria-hidden />
          New story
        </Button>
      </div>

      {storiesQuery.isPending ? (
        <TraySkeleton />
      ) : storiesQuery.isError ? (
        <ErrorState onRetry={() => void storiesQuery.refetch()} />
      ) : (
        <>
          <div className="ghostline-scroll -mx-4 overflow-x-auto px-4 pb-1">
            <ul className="flex min-w-max items-start gap-4">
              <li>
                <OwnStoryTile
                  group={ownGroup}
                  onOpenComposer={() => setComposerOpen(true)}
                  onOpenViewer={openGroup}
                />
              </li>
              {otherGroups.map((g) => (
                <li key={g.owner.publicId}>
                  <StoryTile group={g} onOpen={() => openGroup(g)} />
                </li>
              ))}
            </ul>
          </div>

          {groups.length === 0 && <EmptyState onCreate={() => setComposerOpen(true)} />}
        </>
      )}

      <StoryComposer open={composerOpen} onOpenChange={setComposerOpen} />

      {viewer && viewer.group.stories.length > 0 && (
        <StoryViewer
          key={viewer.group.owner.publicId}
          group={viewer.group}
          startIndex={viewer.startIndex}
          onClose={closeViewer}
        />
      )}
    </div>
  )
}

function TraySkeleton() {
  return (
    <div className="flex min-w-max items-start gap-4" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex w-16 flex-col items-center gap-1.5">
          <Skeleton className="h-16 w-16 rounded-full" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-10 text-center">
      <WifiOff className="h-8 w-8 text-muted-foreground" aria-hidden />
      <div>
        <p className="text-sm font-medium">Could not load stories</p>
        <p className="text-xs text-muted-foreground">Check your connection and try again.</p>
      </div>
      <Button variant="outline" onClick={onRetry} className="min-h-[44px]">
        <RefreshCw className="h-4 w-4" aria-hidden />
        Retry
      </Button>
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-10 text-center">
      <CircleDashed className="h-8 w-8 text-primary" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">
        No stories right now — be the first to share one.
      </p>
      <Button onClick={onCreate} className="min-h-[44px]">
        <Plus className="h-4 w-4" aria-hidden />
        Share a story
      </Button>
    </div>
  )
}

function StoryTile({ group, onOpen }: { group: StoryGroup; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${group.owner.displayName}'s story`}
      className="group flex w-16 flex-col items-center gap-1.5 rounded-lg focus-visible:outline-none"
    >
      <span
        className={cn(
          'block rounded-full p-[3px] transition-transform group-active:scale-95',
          group.hasUnseen ? 'ring-2 ring-primary' : 'ring-2 ring-border'
        )}
      >
        <UserAvatar
          displayName={group.owner.displayName}
          publicId={group.owner.publicId}
          avatarUrl={group.owner.avatarUrl}
          size={56}
          online={group.owner.online}
        />
      </span>
      <span
        title={group.owner.displayName}
        className="w-16 truncate text-center text-[11px] text-muted-foreground"
      >
        {group.owner.displayName}
      </span>
    </button>
  )
}

function OwnStoryTile({
  group,
  onOpenComposer,
  onOpenViewer,
}: {
  group: StoryGroup | undefined
  onOpenComposer: () => void
  onOpenViewer: (group: StoryGroup) => void
}) {
  const hasStories = Boolean(group && group.stories.length > 0)

  return (
    <div className="flex w-16 flex-col items-center gap-1.5">
      <div className="relative">
        {hasStories && group ? (
          <button
            type="button"
            onClick={() => onOpenViewer(group)}
            aria-label="Open your story"
            className="group block rounded-lg focus-visible:outline-none"
          >
            <span
              className={cn(
                'block rounded-full p-[3px] transition-transform group-active:scale-95',
                group.hasUnseen ? 'ring-2 ring-primary' : 'ring-2 ring-border'
              )}
            >
              <UserAvatar
                displayName={group.owner.displayName}
                publicId={group.owner.publicId}
                avatarUrl={group.owner.avatarUrl}
                size={56}
              />
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenComposer}
            aria-label="Add your story"
            className="flex h-[62px] w-[62px] items-center justify-center rounded-full border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none"
          >
            <Plus className="h-6 w-6" aria-hidden />
          </button>
        )}

        {hasStories && (
          <button
            type="button"
            onClick={onOpenComposer}
            aria-label="Add to your story"
            className="absolute -bottom-0.5 -right-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-primary/90 focus-visible:outline-none"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      <span className="w-16 truncate text-center text-[11px] text-muted-foreground">
        Your story
      </span>
    </div>
  )
}

export default StoriesScreen
