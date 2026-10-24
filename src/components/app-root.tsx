"use client";

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { Ghost, WifiOff } from 'lucide-react'
import { api } from '@/lib/client-api'
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
import { InstallPrompt } from '@/components/shared/install-prompt'
import { cn } from '@/lib/utils'
import type { SessionResponse } from '@/lib/types'

/** Tab index order drives the push/pop direction of the slide transition. */
const TAB_ORDER: Tab[] = ['people', 'nearby', 'feed', 'stories', 'chats', 'profile']
const PAGE_SPRING = { type: 'spring' as const, stiffness: 400, damping: 38, mass: 0.9 }

function Splash() {
  return (
    <div className="app-shell flex flex-col items-center justify-center gap-3">
      <Ghost className="h-10 w-10 text-primary animate-pulse" aria-hidden />
      <p className="text-sm text-muted-foreground">Tuning into the ghost frequency…</p>
    </div>
  )
}

export function AppRoot() {
  const queryClient = useQueryClient()
  const reduced = useReducedMotion() ?? false
  const {
    profile,
    profileChecked,
    setProfile,
    tab,
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
    },
    [openConversation],
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
    <div className="app-shell flex flex-col">
      {/* Top bar (app-header grows by the safe-area inset when installed) */}
      <header className="app-header sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/70 bg-background/80 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/12 ring-1 ring-primary/15">
            <Ghost className="h-5 w-5 text-primary" aria-hidden />
          </span>
          <span className="font-semibold tracking-tight">Ghostline</span>
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
          <div className="relative flex-1 flex flex-col overflow-x-clip">
            <AnimatePresence initial={false} mode="popLayout" custom={direction}>
              {activeConversationId ? (
                <motion.div
                  key="chat"
                  custom={direction}
                  variants={chatVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={PAGE_SPRING}
                  className="flex-1 min-h-0 flex flex-col"
                >
                  <ChatView conversationId={activeConversationId} />
                </motion.div>
              ) : (
                <motion.div
                  key={tab}
                  custom={direction}
                  variants={tabVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={PAGE_SPRING}
                  className="flex-1 flex flex-col"
                >
                  {tab === 'people' && <PeopleScreen />}
                  {tab === 'nearby' && <NearbyScreen />}
                  {tab === 'feed' && <FeedScreen />}
                  {tab === 'stories' && <StoriesScreen />}
                  {tab === 'chats' && <ChatsScreen />}
                  {tab === 'profile' && <ProfileScreen />}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {/* Sticky footer (desktop; mobile bottom nav plays this role) */}
          <footer className="hidden md:block mt-auto py-3 text-center text-[11px] text-muted-foreground border-t">
            Ghostline — anonymous, no matching algorithms. See who's online, chat directly, stay in
            control of your visibility. 13+ only.
          </footer>
        </main>
      </div>

      {!chatOpen && <BottomNav unread={unread} />}
      {/* Add-to-Home-Screen popup with auto-triggers — reopens every session until installed */}
      <InstallPrompt
        pwa={pwa}
        active={installEligible}
        open={installPromptOpen}
        onOpenChange={setInstallPromptOpen}
      />
      {/* Notification permission nudge — reappears on every refresh until enabled.
          Suppressed while a deep-link invite dialog is up (never stack two dialogs). */}
      <NotificationPrompt active={!chatOpen && !pendingInviteCode} onResolved={handleNotifResolved} />
      {pendingInviteCode && <InviteDialog code={pendingInviteCode} onClose={() => setPendingInviteCode(null)} />}
    </div>
  )
}
