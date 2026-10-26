"use client";

import { memo, useCallback, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import {
  ChevronDown,
  ChevronUp,
  Flame,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
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
import { ReportDialog } from '@/components/shared/report-dialog'
import { relativeTime } from '@/components/screens/profile/profile-bits'
import type { PostCommentDTO, PostDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Buzz — Hushly's text-only public feed (à la Jodel): say what's on your
 * mind, everyone can like/dislike and comment. No pictures, no videos.
 * Votes are optimistic (server reconciles), posts/comments arrive live via
 * the feed:update socket broadcast + a 30s poll as the safety net.
 */

type Sort = 'hot' | 'new'

type DeleteTarget =
  | { type: 'post'; postId: string }
  | { type: 'comment'; postId: string; commentId: string }
  | null

type ReportTarget = { publicId?: string; postId?: string; label: string } | null

const spring = { type: 'spring' as const, stiffness: 400, damping: 34 }

export function FeedScreen() {
  const queryClient = useQueryClient()
  const profile = useAppStore((s) => s.profile)
  const myPublicId = profile?.publicId ?? null

  const [sort, setSort] = useState<Sort>('hot')
  const [text, setText] = useState('')
  const [anonymousPost, setAnonymousPost] = useState(false)
  const [posting, setPosting] = useState(false)
  const [voteBusyId, setVoteBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget>(null)
  const [reportTarget, setReportTarget] = useState<ReportTarget>(null)

  const posts = useQuery({
    queryKey: ['posts', sort],
    queryFn: () => api.getPosts(sort),
    refetchInterval: 30_000,
  })

  /** Patch a post across every cached sort so both views stay truthful. */
  const patchPost = useCallback(
    (postId: string, patch: Partial<PostDTO>) => {
      for (const s of ['hot', 'new'] as const) {
        queryClient.setQueryData<{ posts: PostDTO[]; sort: string }>(['posts', s], (old) =>
          old ? { ...old, posts: old.posts.map((p) => (p.id === postId ? { ...p, ...patch } : p)) } : old
        )
      }
    },
    [queryClient]
  )

  /** Optimistic like/dislike with toggle-off; server truth overwrites. */
  const vote = useCallback(
    async (post: PostDTO, value: 1 | -1) => {
      if (post.isOwn || voteBusyId) return
      const next = post.myVote === value ? 0 : value
      const delta = next - post.myVote
      setVoteBusyId(post.id)
      patchPost(post.id, { myVote: next, voteScore: post.voteScore + delta })
      try {
        const res = await api.votePost(post.id, next)
        patchPost(post.id, { voteScore: res.voteScore, myVote: res.myVote })
      } catch (err) {
        patchPost(post.id, { myVote: post.myVote, voteScore: post.voteScore })
        toast.error(err instanceof ApiClientError ? err.message : 'Could not record your vote.')
      } finally {
        setVoteBusyId(null)
      }
    },
    [patchPost, voteBusyId]
  )

  async function publish() {
    const t = text.trim()
    if (!t || posting) return
    setPosting(true)
    try {
      const res = await api.createPost(t, anonymousPost)
      setText('')
      // Prepend to both cached sorts (hot re-ranks on the next refetch).
      for (const s of ['hot', 'new'] as const) {
        queryClient.setQueryData<{ posts: PostDTO[]; sort: string }>(['posts', s], (old) =>
          old ? { ...old, posts: [res.post, ...old.posts] } : old
        )
      }
      toast.success('Posted to Buzz.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not publish your post.')
    } finally {
      setPosting(false)
    }
  }

  /** Cached-counter sync from comment create/delete (wraps patchPost for memo stability). */
  const onCountChange = useCallback(
    (postId: string, commentCount: number) => patchPost(postId, { commentCount }),
    [patchPost]
  )

  async function refresh() {
    setRefreshing(true)
    await posts.refetch()
    setRefreshing(false)
  }

  async function doDelete() {
    if (!confirmDelete) return
    const target = confirmDelete
    setConfirmDelete(null)
    try {
      if (target.type === 'post') {
        await api.deletePost(target.postId)
        for (const s of ['hot', 'new'] as const) {
          queryClient.setQueryData<{ posts: PostDTO[]; sort: string }>(['posts', s], (old) =>
            old ? { ...old, posts: old.posts.filter((p) => p.id !== target.postId) } : old
          )
        }
        toast.success('Post deleted.')
      } else {
        const res = await api.deleteComment(target.postId, target.commentId)
        queryClient.setQueryData<{ post: PostDTO; comments: PostCommentDTO[] }>(
          ['post-thread', target.postId],
          (old) =>
            old
              ? { ...old, comments: old.comments.filter((c) => c.id !== target.commentId) }
              : old
        )
        patchPost(target.postId, { commentCount: res.commentCount })
        toast.success('Comment removed.')
      }
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not delete.')
    }
  }

  const list = posts.data?.posts ?? []

  return (
    <div className="flex-1 flex flex-col max-w-2xl w-full mx-auto p-4 gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" aria-hidden /> Buzz
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            What&apos;s on your mind? Drop a thought, vote &amp; comment ✍️
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center rounded-lg border p-0.5" role="group" aria-label="Sort posts">
            {(['hot', 'new'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                aria-pressed={sort === s}
                className={cn(
                  'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1',
                  sort === s ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {s === 'hot' ? <Flame className="h-3.5 w-3.5" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
                {s === 'hot' ? 'Hot' : 'New'}
              </button>
            ))}
          </div>
          <Button variant="outline" size="icon" onClick={refresh} disabled={refreshing} aria-label="Refresh feed">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Composer */}
      <Card>
        <CardContent className="p-3.5 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <UserAvatar
              displayName={anonymousPost ? 'Anonymous' : profile?.displayName ?? 'You'}
              publicId={anonymousPost ? 'anonymous' : myPublicId ?? 'me'}
              avatarUrl={anonymousPost ? null : profile?.avatarUrl ?? null}
              online={anonymousPost ? undefined : true}
              size={30}
            />
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 300))}
              placeholder="What's on your mind?"
              aria-label="Write a post"
              rows={2}
              maxLength={300}
              className="min-h-[52px] resize-none border-0 p-1 focus-visible:ring-0 shadow-none text-sm"
            />
          </div>
          <div className="flex items-center justify-between gap-2 pl-[42px]">
            <div className="flex items-center gap-2">
              <span className={cn('text-[11px] tabular-nums', text.length > 280 ? 'text-amber-500' : 'text-muted-foreground')}>
                {text.length}/300
              </span>
              <label htmlFor="anonymous-post" className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <Switch id="anonymous-post" checked={anonymousPost} onCheckedChange={setAnonymousPost} />
                Post anonymously
              </label>
            </div>
            <Button size="sm" onClick={() => void publish()} disabled={!text.trim() || posting}>
              {posting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              Post
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* List */}
      {posts.isLoading ? (
        <div className="space-y-2.5" role="status" aria-label="Loading posts">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : posts.isError ? (
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">
              {posts.error instanceof ApiClientError ? posts.error.message : 'Could not load the feed.'}
            </p>
            <Button variant="outline" onClick={() => posts.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Zap className="h-9 w-9 mx-auto text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-muted-foreground leading-relaxed">
              It&apos;s quiet in here. Be the first to say what&apos;s on your mind — your post shows
              up for everyone instantly.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2.5" aria-label="Buzz posts">
          {list.map((p) => (
            <li key={p.id}>
              <PostCard
                post={p}
                voteBusy={voteBusyId === p.id}
                onVote={vote}
                onDeletePost={(post) => setConfirmDelete({ type: 'post', postId: post.id })}
                onReport={(post) =>
                  setReportTarget(
                    post.author.isAnonymous
                      ? { postId: post.id, label: post.author.displayName }
                      : { publicId: post.author.publicId, label: post.author.displayName }
                  )
                }
                onCountChange={onCountChange}
                onAskDeleteComment={(postId, commentId) =>
                  setConfirmDelete({ type: 'comment', postId, commentId })
                }
              />
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-muted-foreground leading-relaxed flex gap-1.5 mt-auto pb-1">
        <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
        <span>
          Text posts only — no pictures or videos. Everyone on Hushly sees Buzz. Be kind, report
          anything that breaks the rules.
        </span>
      </p>

      {/* Deletion confirm (posts + comments share one dialog) */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDelete?.type === 'post' ? 'Delete this post?' : 'Remove this comment?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.type === 'post'
                ? 'The post, its votes and all comments disappear for everyone. This cannot be undone.'
                : 'The comment disappears for everyone. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void doDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Report (others' posts) */}
      <ReportDialog
        open={!!reportTarget}
        onOpenChange={(o) => !o && setReportTarget(null)}
        publicId={reportTarget?.publicId}
        postId={reportTarget?.postId}
        label={reportTarget ? `the post by ${reportTarget.label}` : undefined}
      />
    </div>
  )
}

// ─── Post card (memoized: votes/comments re-render only the touched card) ────

type PostCardProps = {
  post: PostDTO
  voteBusy: boolean
  onVote: (post: PostDTO, value: 1 | -1) => void
  onDeletePost: (post: PostDTO) => void
  onReport: (post: PostDTO) => void
  onCountChange: (postId: string, commentCount: number) => void
  onAskDeleteComment: (postId: string, commentId: string) => void
}

const PostCard = memo(function PostCard({
  post,
  voteBusy,
  onVote,
  onDeletePost,
  onReport,
  onCountChange,
  onAskDeleteComment,
}: PostCardProps) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [anonymousComment, setAnonymousComment] = useState(false)
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  // Comments load lazily the first time the thread is opened.
  const thread = useQuery({
    queryKey: ['post-thread', post.id],
    queryFn: () => api.getPostThread(post.id),
    enabled: open,
  })

  async function submitComment() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      const res = await api.commentPost(post.id, t, anonymousComment)
      setText('')
      if (inputRef.current) inputRef.current.style.height = 'auto'
      queryClient.setQueryData<{ post: PostDTO; comments: PostCommentDTO[] }>(
        ['post-thread', post.id],
        (old) => (old ? { ...old, comments: [...old.comments, res.comment] } : old)
      )
      onCountChange(post.id, res.commentCount)
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not comment.')
    } finally {
      setSending(false)
    }
  }

  const comments = thread.data?.comments ?? []

  return (
    <motion.div layout="position" transition={spring}>
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex gap-2.5 p-3.5 pb-2.5">
            {/* Vote rail */}
            <div className="flex flex-col items-center gap-0.5 w-8 shrink-0 select-none">
              <button
                type="button"
                onClick={() => onVote(post, 1)}
                disabled={post.isOwn || voteBusy}
                aria-pressed={post.myVote === 1}
                aria-label={post.myVote === 1 ? 'Remove like' : 'Like this post'}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md transition-colors touch-manipulation',
                  post.isOwn
                    ? 'opacity-25 cursor-not-allowed text-muted-foreground'
                    : post.myVote === 1
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <ChevronUp className="h-5 w-5" aria-hidden />
              </button>
              <span
                aria-label={`${post.voteScore} points`}
                className={cn(
                  'text-sm font-bold tabular-nums leading-none py-0.5',
                  post.myVote === 1 && 'text-emerald-500',
                  post.myVote === -1 && 'text-rose-500'
                )}
              >
                {post.voteScore > 0 ? `+${post.voteScore}` : post.voteScore}
              </span>
              <button
                type="button"
                onClick={() => onVote(post, -1)}
                disabled={post.isOwn || voteBusy}
                aria-pressed={post.myVote === -1}
                aria-label={post.myVote === -1 ? 'Remove dislike' : 'Dislike this post'}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md transition-colors touch-manipulation',
                  post.isOwn
                    ? 'opacity-25 cursor-not-allowed text-muted-foreground'
                    : post.myVote === -1
                      ? 'bg-rose-500/15 text-rose-500'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <ChevronDown className="h-5 w-5" aria-hidden />
              </button>
            </div>

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <UserAvatar
                  displayName={post.author.displayName}
                  publicId={post.author.publicId}
                  avatarUrl={post.author.avatarUrl}
                  online={post.author.online}
                  size={20}
                />
                <span className="text-xs font-medium truncate">{post.author.displayName}</span>
                {post.isOwn && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide bg-primary/10 text-primary rounded px-1 py-px">
                    You
                  </span>
                )}
                <span className="text-xs text-muted-foreground shrink-0">· {relativeTime(post.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-sm whitespace-pre-wrap break-words leading-relaxed">{post.text}</p>

              {/* Footer actions */}
              <div className="mt-2 flex items-center gap-1 -ml-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-muted-foreground"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                >
                  <MessageSquare className="h-4 w-4" aria-hidden />
                  {post.commentCount}
                  <span className="sr-only">comments</span>
                </Button>
                {post.isOwn ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-muted-foreground hover:text-destructive"
                    onClick={() => onDeletePost(post)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                    <span className="sr-only">Delete post</span>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-muted-foreground hover:text-foreground"
                    onClick={() => onReport(post)}
                  >
                    <TriangleAlert className="h-4 w-4" aria-hidden />
                    <span className="sr-only">Report post</span>
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Comments thread */}
          {open && (
            <div className="border-t bg-muted/25">
              {thread.isLoading ? (
                <div className="p-3.5 space-y-2.5" role="status" aria-label="Loading comments">
                  <Skeleton className="h-9 w-full rounded-lg" />
                  <Skeleton className="h-9 w-3/4 rounded-lg" />
                </div>
              ) : comments.length === 0 ? (
                <p className="px-3.5 pt-3 text-xs text-muted-foreground">
                  No comments yet — start the conversation.
                </p>
              ) : (
                <ul className="px-3.5 py-2.5 space-y-2 max-h-72 overflow-y-auto ghostline-scroll">
                  {comments.map((c) => (
                    <li key={c.id} className="flex items-start gap-2">
                      <UserAvatar
                        displayName={c.author.displayName}
                        publicId={c.author.publicId}
                        avatarUrl={c.author.avatarUrl}
                        online={c.author.online}
                        size={18}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <span className={cn('font-medium', c.isOwn ? 'text-primary' : 'text-foreground/80')}>
                            {c.isOwn ? 'You' : c.author.displayName}
                          </span>
                          · {relativeTime(c.createdAt)}
                        </p>
                        <p className="text-xs whitespace-pre-wrap break-words leading-relaxed">{c.text}</p>
                      </div>
                      {(c.isOwn || post.isOwn) && (
                        <button
                          type="button"
                          onClick={() => onAskDeleteComment(post.id, c.id)}
                          aria-label="Remove comment"
                          className="shrink-0 text-muted-foreground/60 hover:text-destructive transition-colors p-1"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* Comment composer */}
              <div className="p-2.5 pt-1.5 space-y-1.5">
                <div className="flex items-end gap-1.5">
                  <Textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value.slice(0, 300))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void submitComment()
                      }
                    }}
                    placeholder="Add a comment…"
                    aria-label="Write a comment"
                    rows={1}
                    maxLength={300}
                    className="min-h-[36px] max-h-24 resize-none field-sizing-content text-xs"
                  />
                  <Button
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => void submitComment()}
                    disabled={!text.trim() || sending}
                    aria-label="Send comment"
                  >
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Send className="h-4 w-4" aria-hidden />
                    )}
                  </Button>
                </div>
                <label htmlFor={`anonymous-comment-${post.id}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                  <Switch
                    id={`anonymous-comment-${post.id}`}
                    checked={anonymousComment}
                    onCheckedChange={setAnonymousComment}
                  />
                  Comment anonymously
                </label>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
})
