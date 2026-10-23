"use client";

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { Eye, Loader2, Timer, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiClientError } from '@/lib/client-api'
import { UserAvatar } from '@/components/shared/user-avatar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { StoryDTO, StoryGroup } from '@/lib/types'

const STORY_DURATION_MS = 5000

const PROGRESS_KEYFRAMES =
  '@keyframes gl-story-progress { from { transform: scaleX(0); } to { transform: scaleX(1); } }'

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return 'just now'
  }
}

function remainingLabel(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now
  if (ms <= 0) return 'expiring now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'expiring now'
  if (mins < 60) return `${mins} min left`
  return `${Math.floor(mins / 60)} h left`
}

/**
 * Immersive full-screen story viewer. Text/image stories auto-advance after
 * 5 s (CSS progress fill); videos advance on their native `ended` event.
 * Tap left third = previous, right two thirds = next; arrows/Escape work too.
 */
export function StoryViewer({
  group,
  startIndex = 0,
  onClose,
}: {
  group: StoryGroup
  startIndex?: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()

  // Local snapshot: deletions mutate this without touching the tray cache.
  const [stories, setStories] = useState<StoryDTO[]>(group.stories)
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(startIndex, 0), Math.max(group.stories.length - 1, 0))
  )
  const [viewedLocally, setViewedLocally] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [now, setNow] = useState(() => Date.now())
  const [videoProgress, setVideoProgress] = useState(0)
  const [viewersOpen, setViewersOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const story: StoryDTO | undefined = stories[index]
  const storyId = story?.id ?? null

  // Keep the index valid after deletions.
  useEffect(() => {
    if (stories.length > 0 && index > stories.length - 1) setIndex(stories.length - 1)
  }, [index, stories.length])

  // Lock body scroll and grab focus while the immersive viewer is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    containerRef.current?.focus()
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const goNext = useCallback(() => {
    if (index >= stories.length - 1) {
      onClose()
      return
    }
    setIndex(index + 1)
  }, [index, stories.length, onClose])

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(i - 1, 0))
  }, [])

  // Keyboard navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight') {
        goNext()
      } else if (e.key === 'ArrowLeft') {
        goPrev()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goNext, goPrev, onClose])

  // Auto-advance for text/image stories (videos advance via onEnded).
  useEffect(() => {
    const current = stories[index]
    if (!current || current.type === 'video') return
    const t = window.setTimeout(goNext, STORY_DURATION_MS)
    return () => window.clearTimeout(t)
  }, [index, stories, goNext])

  // Fire-and-forget view registration for other people's stories (once each).
  useEffect(() => {
    const current = stories[index]
    if (!current || current.isOwn || viewedLocally.has(current.id)) return
    setViewedLocally((prev) => {
      const next = new Set(prev)
      next.add(current.id)
      return next
    })
    void api.viewStory(current.id).catch(() => {
      /* best effort */
    })
  }, [index, stories, viewedLocally])

  // Reset video progress when the slide changes.
  useEffect(() => {
    setVideoProgress(0)
  }, [index])

  // Slow tick so the "time remaining" label stays honest.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const viewersQuery = useQuery({
    queryKey: ['story-viewers', storyId],
    queryFn: () => api.getStoryViewers(storyId ?? ''),
    enabled: Boolean(storyId && story?.isOwn),
  })

  if (!story) return null

  async function handleDelete() {
    if (!story) return
    const targetId = story.id
    setDeleting(true)
    try {
      await api.deleteStory(targetId)
      const remaining = stories.filter((s) => s.id !== targetId)
      setStories(remaining)
      setViewersOpen(false)
      setConfirmDelete(false)
      toast.success('Story deleted.')
      queryClient.invalidateQueries({ queryKey: ['stories'] })
      if (remaining.length === 0) {
        onClose()
      } else {
        setIndex((i) => Math.min(i, remaining.length - 1))
      }
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not delete this story.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Story by ${group.owner.displayName}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 select-none bg-background outline-none"
    >
      <style>{PROGRESS_KEYFRAMES}</style>

      {/* Tap zones: left third = previous, right two thirds = next. They sit
          beneath the body layer, which re-enables pointer events only on the
          video element so its native controls stay usable. */}
      <div className="absolute inset-0 z-0 flex">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Previous story"
          onClick={goPrev}
          className="h-full w-1/3 cursor-default"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Next story"
          onClick={goNext}
          className="h-full w-2/3 cursor-default"
        />
      </div>

      {/* Header: segmented progress bars + owner row */}
      <header className="absolute inset-x-0 top-0 z-20 p-3 pt-4">
        <div className="mb-3 flex gap-1">
          {stories.map((s, i) => (
            <div key={s.id} className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/20">
              <div
                key={i === index ? `active-${s.id}-${index}` : s.id}
                className="h-full w-full origin-left rounded-full bg-foreground"
                style={
                  i < index
                    ? { transform: 'scaleX(1)' }
                    : i > index
                      ? { transform: 'scaleX(0)' }
                      : s.type === 'video'
                        ? { transform: `scaleX(${videoProgress})` }
                        : { animation: `gl-story-progress ${STORY_DURATION_MS}ms linear forwards` }
                }
              />
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2.5">
          <UserAvatar
            displayName={group.owner.displayName}
            publicId={group.owner.publicId}
            avatarUrl={group.owner.avatarUrl}
            size={40}
            online={group.owner.online}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {group.owner.displayName}
              {group.owner.isOwn ? ' (you)' : ''}
            </p>
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Timer className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">
                {timeAgo(story.createdAt)} · {remainingLabel(story.expiresAt, now)}
              </span>
            </p>
          </div>

          {story.isOwn && (
            <button
              type="button"
              onClick={() => setViewersOpen((o) => !o)}
              aria-expanded={viewersOpen}
              title="Who viewed this story"
              className="flex h-11 items-center gap-1.5 rounded-full px-3 text-xs text-foreground/80 transition-colors hover:bg-accent/50"
            >
              <Eye className="h-4 w-4" aria-hidden />
              {viewersQuery.isPending
                ? '…'
                : viewersQuery.data
                  ? viewersQuery.data.viewers.length
                  : '—'}
            </button>
          )}

          {story.isOwn && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete story"
              onClick={() => setConfirmDelete(true)}
              className="size-11 rounded-full text-destructive hover:bg-destructive/15 hover:text-destructive"
            >
              <Trash2 className="h-5 w-5" aria-hidden />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label="Close stories"
            onClick={onClose}
            className="size-11 rounded-full hover:bg-accent/50"
          >
            <X className="h-5 w-5" aria-hidden />
          </Button>
        </div>

        {story.isOwn && viewersOpen && (
          <div className="mt-2 rounded-xl border bg-card/95 p-2 shadow-xl backdrop-blur">
            <p className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Viewed by
            </p>
            {viewersQuery.data && viewersQuery.data.viewers.length > 0 ? (
              <ul className="ghostline-scroll max-h-44 overflow-y-auto">
                {viewersQuery.data.viewers.map((v) => (
                  <li key={v.publicId} className="flex items-center gap-2.5 rounded-lg px-2 py-2">
                    <UserAvatar
                      displayName={v.displayName}
                      publicId={v.publicId}
                      avatarUrl={v.avatarUrl}
                      size={28}
                      online={v.online}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{v.displayName}</span>
                    <span className="text-[11px] text-muted-foreground">{timeAgo(v.viewedAt)}</span>
                  </li>
                ))}
              </ul>
            ) : viewersQuery.isPending ? (
              <p className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Loading viewers…
              </p>
            ) : (
              <p className="px-2 py-3 text-sm text-muted-foreground">No views yet.</p>
            )}
          </div>
        )}
      </header>

      {/* Body */}
      <div className="pointer-events-none relative z-10 flex h-full w-full items-center justify-center px-4 pb-24 pt-28">
        {story.type === 'text' && (
          <p className="max-w-2xl text-balance text-center text-2xl font-medium leading-relaxed sm:text-3xl md:text-4xl">
            {story.text}
          </p>
        )}
        {story.type === 'image' && story.mediaUrl && (
           
          <img
            src={story.mediaUrl}
            alt="Story"
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        )}
        {story.type === 'video' && story.mediaUrl && (
          <video
            ref={videoRef}
            src={story.mediaUrl}
            className="pointer-events-auto max-h-full max-w-full"
            controls
            autoPlay
            playsInline
            muted={false}
            onEnded={goNext}
            onTimeUpdate={(e) => {
              const dur = e.currentTarget.duration
              if (dur > 0) setVideoProgress(Math.min(e.currentTarget.currentTime / dur, 1))
            }}
            onLoadedData={() => {
              void videoRef.current?.play().catch(() => {})
            }}
            onError={() => toast.error('This story could not be played.')}
          />
        )}
      </div>

      {/* Footer hint */}
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-4 pb-5">
        <p className="text-[11px] text-muted-foreground/90">
          Stories vanish 24 h after being shared
        </p>
      </footer>

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this story?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Everyone will stop seeing it immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default StoryViewer
