"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeft,
  SendHorizontal,
  ImagePlus,
  Video as VideoIcon,
  Settings2,
  Check,
  CheckCheck,
  Clock,
  AlertCircle,
  Ban,
  TimerReset,
  Loader2,
  X,
  UsersRound,
  UserPlus,
  Link2,
  Copy,
  RefreshCw,
  LogOut,
  Trash2,
  Crown,
  Star,
} from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { getSocket, currentSocketToken } from '@/lib/socket-client'
import { useAppStore } from '@/store/app-store'
import { UserAvatar } from '@/components/shared/user-avatar'
import { lastSeenLabel, shortTime, countdownLabel } from '@/components/shared/bits'
import { ReportDialog } from '@/components/shared/report-dialog'
import { GroupAddMembersDialog } from '@/components/screens/group-add-members-dialog'
import { copyWithToast } from './profile/profile-bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Dialog, DialogContent } from '@/components/ui/dialog'
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
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { MessageDTO, ExpirationPolicyDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

type ChatTarget = { publicId: string; displayName: string }

type ChatComposerProps = {
  conversationId: string
  disabled?: boolean
  onSendText: (value: string) => void
  onSendMedia: (file: File, kind: 'image' | 'video') => void
}

// Isolated composer: owns its own text state so every keystroke re-renders only
// this component — not the whole message list, dialogs and sheets above it. It
// also owns the typing-emit throttle and the auto-grow height logic.
function ChatComposer({ conversationId, disabled = false, onSendText, onSendMedia }: ChatComposerProps) {
  const reduced = useReducedMotion() ?? false
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)
  const lastTypingSent = useRef(0)
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendingRef = useRef(false) // same-burst guard: rapid repeated Enter cannot double-send

  // Auto-grow like WhatsApp. useLayoutEffect runs before paint (no one-frame-late
  // jump), and field-sizing-fixed neutralizes the shadcn base field-sizing-content
  // so only the JS owns the height — the two sizing mechanisms used to fight.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [text])

  function emitTyping(typing: boolean) {
    try {
      getSocket(currentSocketToken()).emit('typing', {
        conversationId,
        typing,
      })
    } catch {
      /* socket not ready */
    }
  }

  function onInputChange(value: string) {
    setText(value)
    const now = Date.now()
    if (now - lastTypingSent.current > 1500) {
      lastTypingSent.current = now
      emitTyping(true)
    }
    if (typingTimeout.current) clearTimeout(typingTimeout.current)
    typingTimeout.current = setTimeout(() => emitTyping(false), 2000)
  }

  function sendText() {
    if (sendingRef.current) return
    const value = text.trim()
    if (!value) return
    sendingRef.current = true
    setSending(true)
    onSendText(value)
    setText('')
    emitTyping(false)
    // Release the guard on the next macrotask so two Enters landing in the same
    // burst cannot send twice — the optimistic send itself stays synchronous.
    setTimeout(() => {
      sendingRef.current = false
      setSending(false)
    }, 0)
  }

  if (disabled) return null

  return (
    <div className="shrink-0 border-t border-border/70 bg-background/90 p-2.5 pb-[max(10px,env(safe-area-inset-bottom))] backdrop-blur-xl">
      <div className="mx-auto flex max-w-4xl items-end gap-1.5 sm:gap-2">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onSendMedia(f, 'image')
            e.target.value = ''
          }}
        />
        <input
          ref={videoInputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onSendMedia(f, 'video')
            e.target.value = ''
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground sm:h-11 sm:w-11"
          onClick={() => imageInputRef.current?.click()}
          aria-label="Send photo"
        >
          <ImagePlus className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-10 w-10 shrink-0 rounded-xl text-muted-foreground hover:text-foreground sm:h-11 sm:w-11"
          onClick={() => videoInputRef.current?.click()}
          aria-label="Send video"
        >
          <VideoIcon className="h-5 w-5" />
        </Button>
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !window.matchMedia('(pointer: coarse)').matches
            ) {
              e.preventDefault()
              sendText()
            }
          }}
          placeholder="Message…"
          rows={1}
          enterKeyHint="enter"
          autoComplete="off"
          className="min-h-10 max-h-32 resize-none rounded-2xl border-border/70 bg-muted/50 px-4 py-2.5 overflow-y-auto field-sizing-fixed focus-visible:bg-background"
          maxLength={2000}
          aria-label="Message text"
        />
        <motion.div
          className="shrink-0"
          whileTap={reduced ? undefined : { scale: 0.88 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        >
          <Button
            size="icon"
            className="h-10 w-10 rounded-xl shadow-sm sm:h-11 sm:w-11"
            onPointerDown={(event) => event.preventDefault()}
            onClick={sendText}
            disabled={!text.trim() || sending}
            aria-label="Send message"
          >
            <SendHorizontal className="h-4.5 w-4.5" />
          </Button>
        </motion.div>
      </div>
    </div>
  )
}

type MessageBubbleProps = {
  m: MessageDTO
  mine: boolean
  fresh: boolean
  showDay: boolean
  readByOther: boolean
  isGroup: boolean
  reduced: boolean
  onLightbox: (m: MessageDTO) => void
  onRetry: (m: MessageDTO) => void
}

function DeliveryLabel({ createdAt }: { createdAt: string }) {
  const [delayed, setDelayed] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDelayed(true), 5000)
    return () => clearTimeout(timer)
  }, [createdAt])

  return (
    <span role="status" aria-live="polite">
      {delayed ? 'Still sending…' : 'Sending…'}
    </span>
  )
}

function ChatExpirationNotice({
  policy,
  expiresAt,
  onOpenSettings,
}: {
  policy: ExpirationPolicyDTO
  expiresAt: string | null
  onOpenSettings: () => void
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])

  const remaining = policy === 'never' ? null : countdownLabel(expiresAt, now)
  const message =
    policy === 'never'
      ? 'Chat history stays until someone deletes it'
      : `Messages disappear after ${policy === '24h' ? '24 hours' : '3 months'}${remaining ? ` · ${remaining}` : ''}`

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      className="flex min-h-9 w-full shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      aria-label={`${message}. Open chat settings to change.`}
      title={message}
    >
      <TimerReset className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{message}</span>
      <span className="shrink-0 font-medium text-primary">Change</span>
    </button>
  )
}

// Memoized bubble: with the composer isolated and these callbacks stable, a
// parent re-render (socket update, pending patch, dialog toggle) no longer
// re-renders every framer-motion layout node in the list.
const MessageBubble = memo(function MessageBubble({
  m,
  mine,
  fresh,
  showDay,
  readByOther,
  isGroup,
  reduced,
  onLightbox,
  onRetry,
}: MessageBubbleProps) {
  return (
    <motion.div
      layout="position"
      initial={fresh && !reduced ? { opacity: 0, y: 10, x: mine ? 10 : -10, scale: 0.97 } : false}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 35 }}
    >
      {showDay && (
        <div className="flex justify-center my-3">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 bg-muted px-2.5 py-1 rounded-full">
            {new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>
      )}
      <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
        <div
          className={cn(
            'max-w-[82%] sm:max-w-[70%] rounded-2xl px-3 py-2 text-sm',
            mine
              ? 'bg-primary text-primary-foreground rounded-br-md'
              : 'bg-secondary text-secondary-foreground rounded-bl-md',
            m.failed && 'border border-destructive/60'
          )}
        >
          {isGroup && !mine && m.senderName && (
            <p className="text-[11px] font-semibold text-primary/90 mb-0.5 break-words">
              {m.senderName}
            </p>
          )}
          {m.type === 'text' && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
          {m.type === 'image' && m.mediaUrl && (
            <button
              className="block -mx-1 -my-1"
              onClick={() => onLightbox(m)}
              aria-label="View image full size"
            >
              <img
                src={m.mediaUrl}
                alt="Shared photo"
                className="rounded-xl max-w-[220px] sm:max-w-[260px] max-h-[280px] object-cover"
              />
            </button>
          )}
          {m.type === 'video' && m.mediaUrl && (
            <video
              src={m.mediaUrl}
              controls
              playsInline
              preload="metadata"
              className="rounded-xl max-w-[220px] sm:max-w-[280px] max-h-[300px]"
            />
          )}
          <div className={cn('flex items-center gap-1 mt-0.5 justify-end', mine ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
            <span className="text-[10px]">{shortTime(m.createdAt)}</span>
            {mine &&
              (m.failed ? (
                <button onClick={() => onRetry(m)} aria-label="Retry sending" title="Failed — tap to retry">
                  <AlertCircle className="h-3 w-3 text-destructive" />
                </button>
              ) : m.pending ? (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3 animate-pulse" aria-hidden />
                  <DeliveryLabel createdAt={m.createdAt} />
                </span>
              ) : readByOther ? (
                <CheckCheck className="h-3 w-3" aria-label="Read" />
              ) : (
                <Check className="h-3 w-3" aria-label="Sent" />
              ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
})

export function ChatView({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient()
  const setTab = useAppStore((s) => s.setTab)
  const typingState = useAppStore((s) => s.typing[conversationId])
  const reduced = useReducedMotion() ?? false

  const [lightbox, setLightbox] = useState<MessageDTO | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [pending, setPending] = useState<MessageDTO[]>([])
  const [renaming, setRenaming] = useState('')
  const [addMembersOpen, setAddMembersOpen] = useState(false)
  const [inviteInfo, setInviteInfo] = useState<{ joinCode: string; shareUrl: string } | null>(null)
  const [inviteLoading, setInviteLoading] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [favoriteBusy, setFavoriteBusy] = useState(false)

  const bottomRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true) // list pinned to bottom until the user scrolls up
  const lastReadRef = useRef<number>(0)
  const lastViewportHeightRef = useRef(-1)
  const mediaFileIdsRef = useRef(new Map<string, string>())
  const mediaPreviewUrlsRef = useRef(new Map<string, string>())

  useEffect(
    () => () => {
      for (const url of mediaPreviewUrlsRef.current.values()) URL.revokeObjectURL(url)
    },
    []
  )

  const conversation = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.getConversation(conversationId),
    retry: false,
  })

  const messages = useInfiniteQuery({
    queryKey: ['messages', conversationId],
    queryFn: async ({ pageParam }: { pageParam: string | null }) =>
      api.getMessages(conversationId, pageParam ?? null),
    initialPageParam: null as string | null,
    getNextPageParam: () => undefined, // we page backwards only
    getPreviousPageParam: (firstPage) => (firstPage.hasMore ? firstPage.oldestCursor : undefined),
    maxPages: 20,
  })

  const conv = conversation.data?.conversation
  const blocked = conversation.data
    ? { me: conversation.data.iBlockedThem, them: conversation.data.theyBlockedMe }
    : { me: false, them: false }

  const gone =
    conversation.error instanceof ApiClientError &&
    (conversation.error.code === 'CONVERSATION_EXPIRED' || conversation.error.code === 'CONVERSATION_ENDED')

  const realMessages = useMemo(() => {
    const pages = messages.data?.pages ?? []
    return [...pages].reverse().flatMap((p) => p.messages)
  }, [messages.data])

  const otherLastReadAt = useMemo(() => {
    const pages = messages.data?.pages ?? []
    return pages[0]?.otherLastReadAt ?? null
  }, [messages.data])

  const myPublicId = useAppStore((s) => s.profile?.publicId)
  const allMessages = useMemo(() => {
    // Dedupe optimistic entries once the real message (same clientId) arrives
    const realClientIds = new Set(realMessages.map((m) => m.clientId).filter(Boolean))
    const pendingVisible = pending.filter((p) => !realClientIds.has(p.clientId))
    return [...realMessages, ...pendingVisible]
  }, [realMessages, pending])

  // Auto-scroll to bottom when messages change (if user is near the bottom)
  const scrollToBottom = useCallback((smooth = false) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' })
  }, [])

  // Auto-scroll on new messages — but only while the user is still pinned to
  // the bottom: never yank the viewport while they are reading history, and
  // "Load older messages" prepending a page must not ruin the scroll position.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom()
  }, [allMessages.length, scrollToBottom])

  // Track whether the user is pinned to the bottom (WhatsApp behavior: opening
  // or closing the keyboard keeps you glued to the newest message).
  const markScrollPinned = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Use the visible viewport directly so browsers that already resize 100dvh
  // when the keyboard opens do not have the keyboard height subtracted twice.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let frame = 0
    const apply = () => {
      const overlap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      const viewportHeight = Math.round(vv.height + vv.offsetTop)
      if (viewportHeight !== lastViewportHeightRef.current) {
        lastViewportHeightRef.current = viewportHeight
        root.style.setProperty('--gl-visual-viewport-height', `${viewportHeight}px`)
      }
      if (overlap > 0) window.scrollTo(0, 0) // keyboard opening — stop iOS window panning
      if (pinnedRef.current) scrollToBottom()
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        apply()
      })
    }
    schedule()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
      root.style.removeProperty('--gl-visual-viewport-height')
      lastViewportHeightRef.current = -1
    }
  }, [scrollToBottom])

  // Mark read whenever the view is open, visible and messages exist
  useEffect(() => {
    if (!conv || allMessages.length === 0) return
    const now = Date.now()
    if (now - lastReadRef.current < 3000) return
    lastReadRef.current = now
    if (document.visibilityState === 'visible') {
      api.markRead(conversationId).catch(() => undefined)
    }
  }, [conv, allMessages.length, conversationId])

  // Ensure realtime subscription for this room (e.g. conversation created elsewhere)
  useEffect(() => {
    try {
      getSocket(currentSocketToken()).emit('conversation:subscribe', { conversationId })
    } catch {
      /* socket not initialized yet — rooms auto-join on connect */
    }
  }, [conversationId])

  const optimisticAppend = useCallback((m: MessageDTO) => {
    setPending((p) => [...p, m])
  }, [])

  const markOptimistic = useCallback((clientId: string, patch: Partial<MessageDTO>) => {
    setPending((p) => p.map((m) => (m.clientId === clientId ? { ...m, ...patch } : m)))
  }, [])

  const confirmOptimistic = useCallback(
    (clientId: string) => {
      markOptimistic(clientId, { pending: false, failed: false })
      mediaFileIdsRef.current.delete(clientId)
      const previewUrl = mediaPreviewUrlsRef.current.get(clientId)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      mediaPreviewUrlsRef.current.delete(clientId)
      void queryClient.invalidateQueries({ queryKey: ['messages', conversationId] }).then(() => {
        const latest = queryClient.getQueryData<typeof messages.data>(['messages', conversationId])
        if (latest?.pages.some((page) => page.messages.some((m) => m.clientId === clientId))) {
          setPending((p) => p.filter((m) => m.clientId !== clientId))
        }
      })
    },
    [conversationId, markOptimistic, messages.data, queryClient]
  )

  const sendViaHttp = useCallback(
    async (payload: { type: string; text?: string; fileId?: string | null }, clientId: string) => {
      try {
        await api.sendMessage(conversationId, { ...payload, clientId })
        // Keep the optimistic bubble visible until the refreshed history
        // contains the server copy; otherwise the message briefly disappears.
        confirmOptimistic(clientId)
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
      } catch (err) {
        if (err instanceof ApiClientError && (err.code === 'CONVERSATION_EXPIRED' || err.code === 'CONVERSATION_ENDED')) {
          setPending((p) => p.filter((m) => m.clientId !== clientId))
          mediaFileIdsRef.current.delete(clientId)
          const previewUrl = mediaPreviewUrlsRef.current.get(clientId)
          if (previewUrl) URL.revokeObjectURL(previewUrl)
          mediaPreviewUrlsRef.current.delete(clientId)
          toast.error(err.message)
          queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
        } else {
          markOptimistic(clientId, { pending: false, failed: true })
        }
      }
    },
    [confirmOptimistic, conversationId, markOptimistic, queryClient]
  )

  const sendViaSocket = useCallback(
    (payload: { type: string; text?: string; fileId?: string | null }, clientId: string) => {
      const socket = getSocket(currentSocketToken())
      if (!socket.connected) {
        sendViaHttp(payload, clientId)
        return
      }
      socket.emit(
        'message:send',
        { conversationId, clientId, type: payload.type, text: payload.text, fileId: payload.fileId ?? undefined },
        (ack: { ok?: boolean; message?: MessageDTO; error?: string }) => {
          if (ack?.ok && ack.message) {
            // The local copy bridges the ack-to-query-refetch gap and is
            // deduplicated as soon as history returns this clientId.
            confirmOptimistic(clientId)
            queryClient.invalidateQueries({ queryKey: ['conversations'] })
          } else if (ack?.error === 'conversation_expired' || ack?.error === 'not_participant') {
            setPending((p) => p.filter((m) => m.clientId !== clientId))
            mediaFileIdsRef.current.delete(clientId)
            const previewUrl = mediaPreviewUrlsRef.current.get(clientId)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            mediaPreviewUrlsRef.current.delete(clientId)
            toast.error('This conversation is closed and cannot accept messages.')
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
            queryClient.invalidateQueries({ queryKey: ['conversations'] })
          } else {
            markOptimistic(clientId, { pending: false, failed: true })
          }
        }
      )
    },
    [confirmOptimistic, conversationId, markOptimistic, queryClient, sendViaHttp]
  )

  // The text arrives fully trimmed from ChatComposer (which also owns the
  // `sending` double-send guard) — this stays a pure optimistic fire-and-forget.
  const sendText = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      const clientId = crypto.randomUUID()
      optimisticAppend({
        id: clientId,
        conversationId,
        senderPublicId: 'me',
        type: 'text',
        text: trimmed,
        mediaUrl: null,
        createdAt: new Date().toISOString(),
        clientId,
        pending: true,
      })
      sendViaSocket({ type: 'text', text: trimmed }, clientId)
    },
    [conversationId, optimisticAppend, sendViaSocket]
  )

  const sendMedia = useCallback(
    async (file: File, kind: 'image' | 'video') => {
      const max = kind === 'image' ? 8 * 1024 * 1024 : 50 * 1024 * 1024
      if (file.size > max) {
        toast.error(`${kind === 'image' ? 'Images' : 'Videos'} must be under ${max / 1024 / 1024} MB.`)
        return
      }
      const clientId = crypto.randomUUID()
      const previewUrl = URL.createObjectURL(file)
      mediaPreviewUrlsRef.current.set(clientId, previewUrl)
      optimisticAppend({
        id: clientId,
        conversationId,
        senderPublicId: 'me',
        type: kind,
        text: null,
        mediaUrl: previewUrl,
        createdAt: new Date().toISOString(),
        clientId,
        pending: true,
      })
      try {
        const up = await api.upload(file, kind)
        mediaFileIdsRef.current.set(clientId, up.id)
        sendViaSocket({ type: kind, fileId: up.id }, clientId)
      } catch (err) {
        setPending((p) => p.filter((m) => m.clientId !== clientId))
        mediaFileIdsRef.current.delete(clientId)
        const previewUrl = mediaPreviewUrlsRef.current.get(clientId)
        if (previewUrl) URL.revokeObjectURL(previewUrl)
        mediaPreviewUrlsRef.current.delete(clientId)
        toast.error(err instanceof ApiClientError ? err.message : 'Upload failed.')
      }
    },
    [conversationId, optimisticAppend, sendViaSocket]
  )

  const retryMessage = useCallback(
    (m: MessageDTO) => {
      const clientId = m.clientId ?? crypto.randomUUID()
      const fileId = mediaFileIdsRef.current.get(clientId)
      if (m.type !== 'text' && !fileId) {
        toast.error('This attachment is no longer available to retry. Please select it again.')
        return
      }
      setPending((p) =>
        p.map((x) =>
          x.id === m.id ? { ...x, clientId, pending: true, failed: false } : x
        )
      )
      if (m.type === 'text') {
        sendViaSocket({ type: 'text', text: m.text ?? '' }, clientId)
      } else {
        sendViaSocket({ type: m.type, fileId }, clientId)
      }
    },
    [sendViaSocket]
  )

  // Stable callbacks handed down to every memoized MessageBubble.
  const openLightbox = useCallback((m: MessageDTO) => setLightbox(m), [])

  async function unblock() {
    if (!conv?.other) return
    try {
      await api.unblockUser(conv.other.publicId)
      toast.success('Unblocked.')
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not unblock.')
    }
  }

  async function changeExpiration(policy: ExpirationPolicyDTO) {
    try {
      await api.updateConversation(conversationId, { expirationPolicy: policy })
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      toast.success('Expiration updated for everyone in this chat.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update expiration.')
    }
  }

  async function saveNickname() {
    if (!conv?.other) return
    const value = renaming.trim()
    if (!value) return
    try {
      await api.renameContact(conv.other.publicId, value)
      toast.success(`Now showing them as "${value}" — only you see this.`)
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['contacts'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not rename.')
    }
  }

  async function saveAsContact() {
    if (!conv?.other) return
    try {
      await api.saveContact(conv.other.publicId)
      toast.success('Saved as a contact. They can now see your friends-only stories.')
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['contacts'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not save contact.')
    }
  }

  async function toggleFavorite() {
    if (!conv?.other || favoriteBusy) return
    const next = !conv.other.favorited
    setFavoriteBusy(true)
    try {
      await api.setContactFavorite(conv.other.publicId, next)
      toast.success(
        next
          ? `${conv.other.displayName} added to favourites.`
          : `${conv.other.displayName} removed from favourites.`
      )
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['contacts'] })
      queryClient.invalidateQueries({ queryKey: ['people'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not update favourite.')
    } finally {
      setFavoriteBusy(false)
    }
  }

  async function block() {
    if (!conv?.other) return
    try {
      await api.blockUser(conv.other.publicId)
      toast.success('Blocked. They can no longer contact you.')
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['blocks'] })
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not block.')
    }
  }

  async function endConversation() {
    try {
      await api.updateConversation(conversationId, { end: true })
      toast.success('Conversation ended.')
      setSettingsOpen(false)
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setTab('chats')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not end conversation.')
    }
  }

  async function deleteConversation() {
    try {
      await api.deleteConversation(conversationId)
      toast.success('Conversation deleted for everyone.')
      setSettingsOpen(false)
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setTab('chats')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not delete conversation.')
    }
  }

  async function leaveGroup() {
    try {
      await api.leaveGroup(conversationId)
      toast.success('You left the group.')
      setSettingsOpen(false)
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      setTab('chats')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not leave the group.')
    }
  }

  async function loadInvite(rotate: boolean) {
    setInviteLoading(true)
    setRotating(rotate)
    try {
      const res = await api.getGroupInvite(conversationId, rotate)
      setInviteInfo({ joinCode: res.joinCode, shareUrl: res.shareUrl })
      if (rotate) toast.success('New code generated — the old link no longer works.')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not load the invite code.')
    } finally {
      setInviteLoading(false)
      setRotating(false)
    }
  }

  // Join codes are per-conversation — drop the cached one when switching chats.
  useEffect(() => {
    setInviteInfo(null)
  }, [conversationId])

  // ── render ─────────────────────────────────────────────────────────────────

  if (gone) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center max-w-md mx-auto">
        <TimerReset className="h-12 w-12 text-muted-foreground" aria-hidden />
        <h2 className="font-semibold text-lg">This conversation has expired</h2>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Its messages and media have been removed according to the expiration policy. Expired chats
          cannot accept new messages.
        </p>
        <Button onClick={() => setTab('chats')}>Back to Chats</Button>
      </div>
    )
  }

  if (conversation.isLoading) {
    return (
      <div className="flex-1 flex flex-col max-w-2xl w-full mx-auto">
        <div className="h-14 border-b flex items-center gap-3 px-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <div className="p-4 space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className={cn('h-12 rounded-2xl', i % 2 ? 'ml-auto w-2/3' : 'w-1/2')} />
          ))}
        </div>
      </div>
    )
  }

  if (conversation.isError || !conv) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {conversation.error instanceof ApiClientError ? conversation.error.message : 'Could not open this chat.'}
        </p>
        <Button variant="outline" onClick={() => setTab('chats')}>Back</Button>
      </div>
    )
  }

  const other = conv.other
  const isGroup = conv.type === 'group'
  const displayName = isGroup
    ? (conv.name ?? 'Group')
    : (other?.nickname ?? other?.displayName ?? 'Chat')
  const canSend = conv.status === 'active' && (isGroup || (!blocked.me && !blocked.them))
  const someoneTyping = typingState && Date.now() - typingState.at < 4000

  return (
    <div className="gl-chat-viewport flex flex-col max-w-5xl w-full mx-auto">
      {/* Header */}
      <div className="h-16 shrink-0 border-b flex items-center gap-2.5 px-2.5 sm:px-4 bg-background/85 backdrop-blur-xl">
        <Button variant="ghost" size="icon" onClick={() => setTab('chats')} aria-label="Back to chats">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <UserAvatar
          displayName={displayName}
          publicId={isGroup ? `group:${conversationId}` : (other?.publicId ?? '')}
          avatarUrl={isGroup ? null : other?.avatarUrl}
          online={isGroup ? undefined : other?.online}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate leading-tight">
            {displayName}
            {!isGroup && other?.nickname && (
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                ({other.displayName})
              </span>
            )}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {someoneTyping ? (
              <span className="text-primary">typing…</span>
            ) : isGroup ? (
              `${conv.members.length + 1} member${conv.members.length + 1 === 1 ? '' : 's'}`
            ) : (
              lastSeenLabel(other?.online ?? false, other?.lastSeenAt ?? null)
            )}
          </p>
        </div>
        {!isGroup && other && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleFavorite}
            disabled={favoriteBusy}
            aria-pressed={other.favorited}
            aria-label={other.favorited ? `Remove ${other.displayName} from favourites` : `Favourite ${other.displayName}`}
            title={other.favorited ? 'Remove from favourites' : 'Add to favourites'}
          >
            <Star className={cn('h-4 w-4', other.favorited && 'fill-amber-400 text-amber-400')} />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={() => { setRenaming(displayName); setSettingsOpen(true) }} aria-label="Chat settings">
          <Settings2 className="h-5 w-5" />
        </Button>
      </div>

      {!isGroup && (
        <ChatExpirationNotice
          policy={conv.expirationPolicy}
          expiresAt={conv.expiresAt}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* Banners */}
      <div className="shrink-0 space-y-px">
        {blocked.me && (
          <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5 text-xs flex items-center gap-2">
            <Ban className="h-3.5 w-3.5 text-amber-500 shrink-0" aria-hidden />
            <span className="flex-1">You blocked this user. Messaging is paused for both of you.</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={unblock}>
              Unblock
            </Button>
          </div>
        )}
        {blocked.them && (
          <div className="bg-muted px-4 py-2.5 text-xs flex items-center gap-2 text-muted-foreground">
            <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Messaging is unavailable between you and this user.
          </div>
        )}
        {conv.expiresSoon && conv.status === 'active' && (
          <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 text-xs flex items-center gap-2 text-amber-500">
            <TimerReset className="h-3.5 w-3.5 shrink-0" aria-hidden />
            This chat self-deletes in {countdownLabel(conv.expiresAt) ?? 'soon'} — extend it in settings.
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={markScrollPinned}       className="flex-1 overflow-y-auto ghostline-scroll touch-scroll overscroll-contain px-3 py-4 sm:px-6 sm:py-6 space-y-1.5">
        {messages.hasNextPage && !messages.isFetchingPreviousPage && (
          <div className="flex justify-center pb-2">
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => messages.fetchPreviousPage()}>
              Load older messages
            </Button>
          </div>
        )}
        {messages.isFetchingPreviousPage && (
          <div className="flex justify-center pb-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        )}

        {allMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center py-10">
            <p className="text-sm font-medium">No messages yet</p>
            <p className="text-xs text-muted-foreground max-w-[240px]">
              Break the ice — this conversation {conv.expirationPolicy === 'never' ? 'keeps history until you delete it' : `expires ${conv.expirationPolicy === '24h' ? '24 h after creation' : 'in 3 months'}`}.
            </p>
          </div>
        )}

        {allMessages.map((m, idx) => {
          // Server-generated system markers ("X created the group", "X left")
          if (m.type === 'system') {
            return (
              <motion.div key={m.id} layout="position" initial={false}>
                <div className="flex justify-center my-3">
                  <span className="text-[11px] leading-snug text-muted-foreground bg-muted px-3 py-1.5 rounded-full text-center max-w-[85%]">
                    {m.text}
                  </span>
                </div>
              </motion.div>
            )
          }

          const mine = m.senderPublicId === myPublicId || m.senderPublicId === 'me'
          // Only animate genuinely new messages; bulk history loads mount silently.
          const fresh = m.pending === true || Date.now() - new Date(m.createdAt).getTime() < 10_000
          const prev = allMessages[idx - 1]
          const showDay =
            !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
          const readByOther = Boolean(
            mine && !isGroup && otherLastReadAt && new Date(otherLastReadAt).getTime() >= new Date(m.createdAt).getTime() - 500
          )

          return (
            <MessageBubble
              key={m.id}
              m={m}
              mine={mine}
              fresh={fresh}
              showDay={showDay}
              readByOther={readByOther}
              isGroup={isGroup}
              reduced={reduced}
              onLightbox={openLightbox}
              onRetry={retryMessage}
            />
          )
        })}

        {/* Typing indicator bubble */}
        <AnimatePresence>
          {someoneTyping && (
            <motion.div
              key="typing"
              className="flex justify-start pt-1"
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 500, damping: 35 }}
            >
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-secondary px-3.5 py-2.5" aria-label="Typing">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
                    animate={{ opacity: [0.2, 1, 0.2] }}
                    transition={{ repeat: Infinity, duration: 1.1, delay: i * 0.18, ease: 'easeInOut' }}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>

      {/* Composer — isolated component (owns text state, typing throttle, auto-grow) */}
      {!canSend && (
        <div className="shrink-0 border-t p-2.5 pb-[max(10px,env(safe-area-inset-bottom))] bg-background/90 backdrop-blur">
          <p className="text-center text-xs text-muted-foreground py-2.5">
            {conv.status !== 'active'
              ? 'This conversation has ended — history is read-only until cleanup.'
              : 'Messaging is unavailable while a block is active.'}
          </p>
        </div>
      )}
      <ChatComposer
        conversationId={conversationId}
        disabled={!canSend}
        onSendText={sendText}
        onSendMedia={sendMedia}
      />

      {/* Image lightbox */}
      <Dialog open={!!lightbox} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent className="max-w-3xl p-2 border-none bg-black/90">
          {lightbox?.mediaUrl && (
             
            <img src={lightbox.mediaUrl} alt="Shared photo full size" className="max-h-[80vh] w-auto mx-auto rounded-lg" />
          )}
          <button
            className="absolute top-3 right-3 text-white/80 hover:text-white"
            onClick={() => setLightbox(null)}
            aria-label="Close image"
          >
            <X className="h-5 w-5" />
          </button>
        </DialogContent>
      </Dialog>

      {/* Settings sheet */}
      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto ghostline-scroll">
          <SheetHeader>
            <div className="flex items-center gap-3 pt-2">
              <UserAvatar
                displayName={displayName}
                publicId={isGroup ? `group:${conversationId}` : (other?.publicId ?? '')}
                avatarUrl={isGroup ? null : other?.avatarUrl}
                online={isGroup ? undefined : other?.online}
                size={48}
              />
              <div className="min-w-0">
                <SheetTitle className="truncate">{displayName}</SheetTitle>
                <SheetDescription className="flex items-center gap-1.5">
                  {isGroup
                    ? `${conv.members.length + 1} members`
                    : `${lastSeenLabel(other?.online ?? false, other?.lastSeenAt ?? null)} · Direct chat`}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="space-y-5 px-4 pb-8">
            {isGroup ? (
              <>
                {/* Members */}
                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5">
                      <UsersRound className="h-4 w-4 text-primary" /> Members
                    </h3>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setAddMembersOpen(true)}
                    >
                      <UserPlus className="h-3.5 w-3.5" aria-hidden /> Invite
                    </Button>
                  </div>
                  <ul className="max-h-64 overflow-y-auto ghostline-scroll rounded-lg border divide-y">
                    <li className="flex items-center gap-2.5 px-3 py-2">
                      <UserAvatar
                        displayName={myPublicId ?? 'You'}
                        publicId={myPublicId ?? 'me'}
                        avatarUrl={null}
                        size={30}
                      />
                      <span className="text-sm font-medium flex-1">You</span>
                      {conv.createdByPublicId === myPublicId && (
                        <span className="flex items-center gap-1 text-[10px] text-amber-500">
                          <Crown className="h-3 w-3" aria-hidden /> creator
                        </span>
                      )}
                    </li>
                    {conv.members.map((m) => (
                      <li key={m.publicId} className="flex items-center gap-2.5 px-3 py-2">
                        <UserAvatar
                          displayName={m.displayName}
                          publicId={m.publicId}
                          avatarUrl={m.avatarUrl}
                          online={m.online}
                          size={30}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium truncate">
                            {m.nickname ?? m.displayName}
                          </span>
                          {m.nickname && (
                            <span className="block text-[10px] text-muted-foreground truncate">
                              ({m.displayName})
                            </span>
                          )}
                        </span>
                        {m.publicId === conv.createdByPublicId && (
                          <span className="flex items-center gap-1 text-[10px] text-amber-500 shrink-0">
                            <Crown className="h-3 w-3" aria-hidden /> creator
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <Separator />

                {/* Invite by shareable code */}
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5">
                    <Link2 className="h-4 w-4 text-primary" /> Group invite code
                  </h3>
                  {inviteInfo ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                        <span className="flex-1 font-mono text-sm tracking-widest truncate">
                          {inviteInfo.joinCode}
                        </span>
                        <button
                          type="button"
                          onClick={() => void copyWithToast(inviteInfo.joinCode, 'Invite code copied')}
                          aria-label="Copy invite code"
                          className="h-8 w-8 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent flex items-center justify-center transition-colors"
                        >
                          <Copy className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyWithToast(inviteInfo.shareUrl, 'Invite link copied')}
                          aria-label="Copy invite link"
                          className="h-8 px-2 shrink-0 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-1 transition-colors"
                        >
                          <Link2 className="h-3.5 w-3.5" aria-hidden /> Copy link
                        </button>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Anyone with this code (or link) joins “{conv.name}” — even people you
                        haven&apos;t saved. Blocks always apply.
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => void loadInvite(true)}
                        disabled={rotating || inviteLoading}
                      >
                        {rotating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                        )}
                        New code
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => void loadInvite(false)}
                      disabled={inviteLoading}
                    >
                      {inviteLoading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Link2 className="h-3.5 w-3.5" aria-hidden />
                      )}
                      Show invite code
                    </Button>
                  )}
                </section>

                <Separator />
                <section className="text-[11px] text-muted-foreground leading-relaxed space-y-1">
                  <p>Groups keep their full history — nothing expires until the group is deleted.</p>
                  <Badge variant="outline" className="text-[10px]">Created {shortTime(conv.createdAt)}</Badge>
                </section>

                <Separator />

                {/* Group actions */}
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Actions</h3>
                  <div className="flex flex-wrap gap-2">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost">
                          <LogOut className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Leave group
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Leave this group?</AlertDialogTitle>
                          <AlertDialogDescription>
                            You will stop receiving messages from it. Your past messages stay for the
                            other members.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={leaveGroup}>Leave</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    {conv.createdByPublicId === myPublicId && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button size="sm" variant="ghost" className="text-destructive">
                            <Trash2 className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Delete group
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this group?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Messages and shared media are removed for every member immediately. This
                              cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={deleteConversation}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Only the creator can delete the group — everyone else can leave it anytime.
                  </p>
                </section>
              </>
            ) : (
              <>
                {/* Expiration */}
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5">
                    <TimerReset className="h-4 w-4 text-primary" /> How long this chat lives
                  </h3>
                  <div className="space-y-3 rounded-xl border bg-muted/20 p-3.5">
                    <Select
                      value={conv.expirationPolicy}
                      onValueChange={(value) => {
                        if (value === '24h' || value === '3months' || value === 'never') {
                          void changeExpiration(value)
                        }
                      }}
                    >
                      <SelectTrigger className="h-11 w-full rounded-lg bg-background" aria-label="Chat expiration">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="24h">24 hours</SelectItem>
                        <SelectItem value="3months">3 months</SelectItem>
                        <SelectItem value="never">Never expire</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
                      {conv.expirationPolicy === '24h'
                        ? 'Messages and media are removed 24 hours after this chat starts.'
                        : conv.expirationPolicy === '3months'
                          ? 'Messages and media are removed 3 months after this chat starts.'
                          : 'This chat stays until someone deletes or ends it.'}
                      {conv.expiresAt && ` ${countdownLabel(conv.expiresAt)} remaining.`}
                    </p>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Shared setting — changes apply to both participants. Expired chats and their media
                    are deleted automatically.
                  </p>
                </section>

                <Separator />

                {/* Nickname */}
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Private nickname</h3>
                  <p className="text-xs text-muted-foreground">
                    Rename them just for yourself. {other?.displayName} keeps their own name everywhere else.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={renaming}
                      onChange={(e) => setRenaming(e.target.value)}
                      maxLength={40}
                      placeholder={`e.g. "Person from the library"`}
                    />
                    <Button size="sm" onClick={saveNickname} disabled={!renaming.trim() || renaming.trim() === displayName}>
                      Save
                    </Button>
                  </div>
                  {other?.savedAsContact && (
                    <Button size="sm" variant="outline" onClick={async () => {
                      await api.removeContact(other.publicId).catch(() => undefined)
                      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
                      queryClient.invalidateQueries({ queryKey: ['contacts'] })
                      toast.success('Contact removed (nickname cleared).')
                    }}>
                      Remove from contacts
                    </Button>
                  )}
                </section>

                <Separator />

                {/* Safety */}
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">Safety</h3>
                  <div className="flex flex-wrap gap-2">
                    {blocked.me ? (
                      <Button size="sm" variant="outline" onClick={unblock}>Unblock user</Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={block}>Block user</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setReportOpen(true)}>
                      Report conversation
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost" className="text-muted-foreground">End conversation</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>End this conversation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            No new messages can be sent afterwards. History is removed automatically later.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={endConversation}>End</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="ghost" className="text-destructive">Delete for everyone</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Messages and shared media are removed for both participants immediately. This
                            cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={deleteConversation}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                  {!other?.savedAsContact && (
                    <Button size="sm" variant="secondary" onClick={saveAsContact}>
                      Save as contact
                    </Button>
                  )}
                </section>

                <Separator />

                <section className="text-[11px] text-muted-foreground leading-relaxed space-y-1">
                  <p>Anonymous ID: {other?.publicId}</p>
                  <p>Messages are not end-to-end encrypted; they are stored until expiration.</p>
                  <Badge variant="outline" className="text-[10px]">Created {shortTime(conv.createdAt)}</Badge>
                </section>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {isGroup && (
        <GroupAddMembersDialog
          open={addMembersOpen}
          onClose={() => setAddMembersOpen(false)}
          conversationId={conversationId}
          groupName={conv.name ?? 'group'}
          existingPublicIds={[myPublicId ?? '', ...conv.members.map((m) => m.publicId)]}
        />
      )}

      {!isGroup && other && (
        <ReportDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          publicId={other.publicId}
          conversationId={conversationId}
          label={displayName}
          onBlockedOptional={block}
        />
      )}
    </div>
  )
}
