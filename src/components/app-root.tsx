"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type TouchEvent as ReactTouchEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { WifiOff } from 'lucide-react'
import { api } from '@/lib/client-api'
import { HushlyMark } from '@/components/shared/hushly-mark'
import { useAppStore, type Tab } from '@/store/app-store'
import { useRealtime } from '@/hooks/use-realtime'
import { usePwaRuntime } from '@/hooks/use-pwa'
import { Onboarding } from '@/components/screens/onboarding'
import { BottomNav, SideNav } from '@/components/nav/nav'
import { NearbyScreen } from '@/components/screens/nearby-screen'
import { PeopleScreen } from '@/components/screens/people-screen'
import { StoriesScreen } from '@/components/screens/stories/stories-screen'
import { FeedScreen } from '@/components/screens/feed-screen'
import { ChatsScreen } from '@/components/screens/chats-screen'
import { ProfileScreen } from '@/components/screens/profile/profile-screen'
import { ChatView } from '@/components/screens/chat-view'
import { InviteDialog } from '@/components/screens/invite-dialog'
import { NotificationPrompt } from '@/components/shared/notification-prompt'
import { FirstRunTour } from '@/components/shared/first-run-tour'
import { InstallPrompt } from '@/components/shared/install-prompt'
import { cn } from '@/lib/utils'
import type { SessionResponse } from '@/lib/types'

/** Tab index order drives the push/pop direction of the slide transition. */
const TAB_ORDER: Tab[] = ['people', 'nearby', 'feed', 'stories', 'chats', 'profile']
const PAGE_SPRING = { type: 'spring' as const, stiffness: 400, damping: 38, mass: 0.9 }
const FIRST_RUN_TOUR_KEY = 'gl-first-run-tour-v1'
const subscribeToDevice = () => () => {}

function isIOSDevice() {
  const isIPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || isIPad
}

function Splash() {
  return (
    <div className="app-shell flex flex-col items-center justify-center gap-3">
      <HushlyMark className="h-10 w-10 animate-pulse" aria-hidden />
      <p className="text-sm text-muted-foreground">Tuning into the Hushly signal…</p>
    </div>
  )
}

export function AppRoot() {
  const queryClient = useQueryClient()
  const reduced = useReducedMotion() ?? false
  const isIOS = useSyncExternalStore(subscribeToDevice, isIOSDevice, () => false)
  const {
    profile,
    profileChecked,
    setProfile,
    tab,
    setTab,
    activeConversationId,
    closeConversation,
    pendingInviteCode,
    setPendingInviteCode,
    socketConnected,
    openConversation,
    installPromptOpen,
    setInstallPromptOpen,
  } = useAppStore()

  // ── PWA runtime: SW registration, install prompt, notification deep links ──
  const handleNotificationDeepLink = useCallback(
    (path: string) => {
      const m = path.match(/[?&]chat=([^&]+)/)
      if (m) openConversation(decodeURIComponent(m[1]))
      if (/[?&]tab=feed(?:&|$)/.test(path)) setTab('feed')
    },
    [openConversation, setTab],
  )
  const pwa = usePwaRuntime(handleNotificationDeepLink)

  const session = useQuery({
    queryKey: ['session'],
    queryFn: api.getSession,
    staleTime: Infinity,
    retry: 1,
  })

  useEffect(() => {
    if (session.data) {
      setProfile(session.data.authenticated ? session.data.profile : null)
    }
  }, [session.data, setProfile])

  // Deep-link invite: /?invite=CODE
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const invite = params.get('invite')
    if (invite) {
      setPendingInviteCode(invite.toUpperCase())
      window.history.replaceState(null, '', window.location.pathname)
    }
  }, [setPendingInviteCode])

  // ── Chat = pushed page (WhatsApp-style) ───────────────────────────────────
  // Opening a chat pushes a history entry so the Android/iOS hardware back
  // gesture closes it. Any in-app dismissal (chat back button, nav tab tap,
  // end/delete) consumes the pushed entry automatically — navigation always
  // overrides the back.
  const chatOpen = Boolean(activeConversationId)
  const suppressPopRef = useRef(false)
  const previousTabsRef = useRef<Tab[]>([])
  const lastTabRef = useRef(tab)
  const edgeTouchRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (lastTabRef.current === tab) return
    previousTabsRef.current.push(lastTabRef.current)
    if (previousTabsRef.current.length > 20) previousTabsRef.current.shift()
    lastTabRef.current = tab
  }, [tab])

  const handleEdgeTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!window.matchMedia('(max-width: 767px)').matches) return
    if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')) return
    const touch = event.changedTouches[0]
    if (!touch || touch.clientX > 28) return
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, select, video, [contenteditable="true"], [role="slider"]')
    ) {
      return
    }
    edgeTouchRef.current = { x: touch.clientX, y: touch.clientY }
  }

  const handleEdgeTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = edgeTouchRef.current
    edgeTouchRef.current = null
    const touch = event.changedTouches[0]
    if (!start || !touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (deltaX < 76 || Math.abs(deltaY) > 64) return

    if (chatOpen) {
      closeConversation()
      return
    }

    const history = previousTabsRef.current
    let previousTab = history.pop()
    while (previousTab === tab && history.length > 0) previousTab = history.pop()
    if (!previousTab || previousTab === tab) {
      previousTab = TAB_ORDER[(TAB_ORDER.indexOf(tab) - 1 + TAB_ORDER.length) % TAB_ORDER.length]
    }
    useAppStore.getState().setTab(previousTab)
  }

  useEffect(() => {
    if (chatOpen) {
      suppressPopRef.current = false
      if (!window.history.state?.glChat) window.history.pushState({ glChat: true }, '')
      const onPop = () => {
        suppressPopRef.current = true
        closeConversation()
      }
      window.addEventListener('popstate', onPop)
      return () => window.removeEventListener('popstate', onPop)
    }
    if (window.history.state?.glChat && !suppressPopRef.current) window.history.back()
    suppressPopRef.current = false
  }, [chatOpen, closeConversation])

  // ── Install popup sequencing ────────────────────────────────────────────────
  // The notification question is asked first; only once it is settled (enabled,
  // unsupported, denied, or dismissed this session) does the add-to-home-screen
  // popup become eligible — two stacked dialogs on first load would be chaos.
  const [notifResolved, setNotifResolved] = useState(false)
  const handleNotifResolved = useCallback(() => setNotifResolved(true), [])
  const installEligible =
    !chatOpen && notifResolved && pwa.isMobile && !pwa.isStandalone && !pwa.installed

  const socketToken = session.data?.socketToken ?? null
  useRealtime(socketToken, profile?.publicId ?? null)

  // Lightweight global conversations poll: drives unread badges in nav
  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: api.getConversations,
    refetchInterval: 30_000,
    enabled: Boolean(profile),
  })
  const unread = (conversationsQuery.data?.conversations ?? []).reduce((n, c) => n + c.unreadCount, 0)
  const [tourOpen, setTourOpen] = useState(false)
  const [tourSettled, setTourSettled] = useState(false)
  const tourCheckedRef = useRef(false)

  useEffect(() => {
    if (!profile || chatOpen || pendingInviteCode || tourCheckedRef.current) return

    const timer = window.setTimeout(() => {
      let restoredConversationId: string | null = null
      try {
        restoredConversationId = window.sessionStorage.getItem('gl-active-conv')
      } catch {
        // Session storage can be unavailable in private browsing.
      }
      if (restoredConversationId) {
        if (!conversationsQuery.isSuccess && !conversationsQuery.isError) return
        if (
          conversationsQuery.isSuccess &&
          (conversationsQuery.data?.conversations ?? []).some(
            (conversation) => conversation.id === restoredConversationId
          )
        ) {
          return
        }
      }

      tourCheckedRef.current = true
      let shouldShowTour = true
      try {
        shouldShowTour = window.localStorage.getItem(FIRST_RUN_TOUR_KEY) !== '1'
      } catch {
        shouldShowTour = true
      }
      if (shouldShowTour) setTourOpen(true)
      setTourSettled(true)
    }, 0)

    return () => window.clearTimeout(timer)
  }, [
    profile,
    chatOpen,
    pendingInviteCode,
    conversationsQuery.isSuccess,
    conversationsQuery.isError,
    conversationsQuery.data,
  ])

  const handleTourOpenChange = useCallback((open: boolean) => {
    setTourOpen(open)
    if (!open) {
      try {
        window.localStorage.setItem(FIRST_RUN_TOUR_KEY, '1')
      } catch {
        // The tour can still be dismissed when persistent storage is unavailable.
      }
    }
  }, [])

  // Restore the open chat after a refresh. History itself lives on the server
  // (survives refresh by design); this restores the *view* the user was in.
  const restoredRef = useRef(false)
  useEffect(() => {
    if (!profile || restoredRef.current) return
    if (!conversationsQuery.isSuccess) return
    restoredRef.current = true
    let id: string | null = null
    try {
      id = window.sessionStorage.getItem('gl-active-conv')
    } catch {
      id = null
    }
    if (!id || activeConversationId) return
    if ((conversationsQuery.data?.conversations ?? []).some((c) => c.id === id)) {
      openConversation(id)
    } else {
      try {
        window.sessionStorage.removeItem('gl-active-conv')
      } catch {
        /* private mode */
      }
    }
  }, [profile, conversationsQuery.isSuccess, conversationsQuery.data, activeConversationId, openConversation])

  // Pause heartbeats handled in hook; refresh profile when tab becomes visible again
  const lastVisible = useRef(0)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastVisible.current > 30_000) {
        lastVisible.current = Date.now()
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        queryClient.invalidateQueries({ queryKey: ['nearby'] })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [queryClient])

  function handleReady(data: SessionResponse) {
    queryClient.setQueryData(['session'], data)
    setProfile(data.authenticated ? data.profile : null)
  }

  // Direction for the tab slide: derived from tab index order. Compared
  // during render (guarded setState — the React "adjust state when props
  // change" pattern) so the enter variant has the correct direction
  // immediately, without refs.
  const [prevTab, setPrevTab] = useState<Tab>(tab)
  const [direction, setDirection] = useState(1)
  if (prevTab !== tab) {
    setDirection(TAB_ORDER.indexOf(tab) >= TAB_ORDER.indexOf(prevTab) ? 1 : -1)
    setPrevTab(tab)
  }

  const tabVariants: Variants = reduced
    ? { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        enter: (dir: number) => ({ opacity: 0, x: dir * 28 }),
        center: { opacity: 1, x: 0 },
        exit: (dir: number) => ({ opacity: 0, x: dir * -20 }),
      }

  // iOS-style page push for the chat view (slides up over the tab content).
  const chatVariants: Variants = reduced
    ? { enter: { opacity: 0 }, center: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        enter: { opacity: 0, y: 24, scale: 0.995 },
        center: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: 24, scale: 0.995 },
      }

  const screenContent = activeConversationId ? (
    <ChatView conversationId={activeConversationId} />
  ) : (
    <>
      {tab === 'people' && <PeopleScreen />}
      {tab === 'nearby' && <NearbyScreen />}
      {tab === 'feed' && <FeedScreen />}
      {tab === 'stories' && <StoriesScreen />}
      {tab === 'chats' && <ChatsScreen />}
      {tab === 'profile' && <ProfileScreen />}
    </>
  )

  if (session.isLoading || (session.isPending && !profileChecked)) {
    return <Splash />
  }

  if (session.isError) {
    return (
      <div className="app-shell flex flex-col items-center justify-center gap-3 p-6 text-center">
        <WifiOff className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground max-w-xs">
          We couldn't reach the service. Check your connection and try again.
        </p>
        <button
          className="text-sm text-primary underline"
          onClick={() => session.refetch()}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!profile) {
    return <Onboarding onReady={handleReady} />
  }

  return (
    <div
      className="app-shell flex flex-col"
      onTouchStart={handleEdgeTouchStart}
      onTouchEnd={handleEdgeTouchEnd}
      onTouchCancel={() => {
        edgeTouchRef.current = null
      }}
    >
      {/* Top bar (app-header grows by the safe-area inset when installed) */}
      <header className="app-header sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
        <div className="flex items-center gap-2.5">
          <span className="brand-mark flex h-8 w-8 items-center justify-center rounded-xl ring-1 ring-white/15">
            <HushlyMark className="h-5 w-5" aria-hidden />
          </span>
          <span className="font-semibold tracking-tight">Hushly</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">quiet connections ✨</span>
        </div>
        <div
          title={socketConnected ? 'Realtime connected' : 'Realtime offline — retrying'}
          role="status"
          className="ml-auto flex items-center gap-2 rounded-full border border-border/60 bg-card/60 px-2.5 py-1.5"
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              socketConnected ? 'bg-emerald-400 signal-dot' : 'bg-amber-500'
            )}
            aria-hidden
          />
          <span className="text-[11px] font-medium text-muted-foreground">
            {socketConnected ? 'Live' : 'Reconnecting'}
          </span>
        </div>
      </header>

      <div className="flex flex-1 w-full">
        <SideNav unread={unread} />
        <main
          className={cn(
            'flex-1 min-w-0 flex flex-col',
            // The chat owns the full viewport on mobile (nav hidden; the
            // composer sits flush on the bottom edge / above the keyboard)
            chatOpen ? 'pb-0' : 'pb-[64px] md:pb-0',
          )}
        >
          <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
            {isIOS ? (
              <div
                key={activeConversationId ? 'chat' : tab}
                className="flex-1 min-h-0 flex flex-col overflow-hidden"
              >
                {screenContent}
              </div>
            ) : (
              <AnimatePresence initial={false} mode="wait" custom={direction}>
                <motion.div
                  key={activeConversationId ? 'chat' : tab}
                  custom={direction}
                  variants={activeConversationId ? chatVariants : tabVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={PAGE_SPRING}
                  className="flex-1 min-h-0 flex flex-col overflow-hidden"
                >
                  {screenContent}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
          {/* Sticky footer (desktop; mobile bottom nav plays this role) */}
          <footer className="hidden md:block mt-auto py-3 text-center text-[11px] text-muted-foreground border-t">
            Hushly — quiet by design. See who's online, chat directly, stay in control of your
            visibility. 13+ only.
          </footer>
        </main>
      </div>

      {!chatOpen && <BottomNav unread={unread} />}
      {/* Add-to-Home-Screen popup with auto-triggers — reopens every session until installed */}
      <InstallPrompt
        pwa={pwa}
        active={installEligible && !tourOpen}
        open={installPromptOpen && !tourOpen}
        onOpenChange={setInstallPromptOpen}
      />
      <FirstRunTour open={tourOpen} onOpenChange={handleTourOpenChange} />
      {/* Notification permission nudge — reappears on every refresh until enabled.
          Suppressed while a deep-link invite dialog is up (never stack two dialogs). */}
      <NotificationPrompt
        active={tourSettled && !tourOpen && !chatOpen && !pendingInviteCode}
        onResolved={handleNotifResolved}
      />
      {pendingInviteCode && <InviteDialog code={pendingInviteCode} onClose={() => setPendingInviteCode(null)} />}
    </div>
  )
}
