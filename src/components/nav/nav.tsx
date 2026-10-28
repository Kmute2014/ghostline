"use client";

import { Users, MapPin, CircleDashed, MessagesSquare, UserRound, Zap } from 'lucide-react'
import { motion, useReducedMotion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useAppStore, type Tab } from '@/store/app-store'

export const NAV_ITEMS: { tab: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { tab: 'people', label: 'People', icon: Users },
  { tab: 'nearby', label: 'Nearby', icon: MapPin },
  { tab: 'feed', label: 'Buzz', icon: Zap },
  { tab: 'stories', label: 'Stories', icon: CircleDashed },
  { tab: 'chats', label: 'Chats', icon: MessagesSquare },
  { tab: 'profile', label: 'Profile', icon: UserRound },
]

const TAP_SPRING = { type: 'spring' as const, stiffness: 500, damping: 30 }
const PILL_SPRING = { type: 'spring' as const, stiffness: 500, damping: 35 }

function getBadgeCount(
  tab: Tab,
  unread: number,
  activityCounts: Record<Tab, number>,
  peopleOnlineCount: number | null,
): number | null {
  if (tab === 'people') return peopleOnlineCount
  if (tab === 'chats') return unread > 0 ? unread : null
  return activityCounts[tab] > 0 ? activityCounts[tab] : null
}

/** Mobile: fixed bottom navigation bar (thumb friendly, 5 destinations) */
export function BottomNav({
  unread,
  activityCounts,
  peopleOnlineCount,
}: {
  unread: number
  activityCounts: Record<Tab, number>
  peopleOnlineCount: number | null
}) {
  const { tab, setTab } = useAppStore()
  const reduced = useReducedMotion() ?? false
  return (
    <nav
      aria-label="Main navigation"
      className="no-select md:hidden fixed bottom-0 inset-x-0 z-40 border-t bg-background/90 backdrop-blur-lg supports-[backdrop-filter]:bg-background/75 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="grid grid-cols-6">
        {NAV_ITEMS.map(({ tab: t, label, icon: Icon }) => {
          const active = tab === t
          const badgeCount = getBadgeCount(t, unread, activityCounts, peopleOnlineCount)
          return (
            <motion.button
              key={t}
              onClick={() => setTab(t)}
              aria-current={active ? 'page' : undefined}
              aria-label={t === 'people' && badgeCount !== null ? `${label}, ${badgeCount} online` : label}
              whileTap={reduced ? undefined : { scale: 0.82 }}
              transition={TAP_SPRING}
              className={cn(
                'relative flex flex-col items-center justify-center gap-0.5 rounded-xl py-2.5 text-[10px] font-medium transition-colors min-h-[56px] touch-manipulation',
                active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <motion.span
                className="relative"
                animate={active && !reduced ? { y: -1 } : { y: 0 }}
                transition={TAP_SPRING}
              >
                <Icon className={cn('h-5 w-5 transition-transform', active && 'scale-110')} />
                {badgeCount !== null && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold flex items-center justify-center">
                    {badgeCount > 99 ? '99+' : badgeCount}
                  </span>
                )}
              </motion.span>
              {label}
              {active && (
                <motion.span
                  layoutId="nav-active-pill"
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-primary"
                  transition={reduced ? { duration: 0 } : PILL_SPRING}
                />
              )}
            </motion.button>
          )
        })}
      </div>
    </nav>
  )
}

/** Desktop: persistent sidebar */
export function SideNav({
  unread,
  activityCounts,
  peopleOnlineCount,
}: {
  unread: number
  activityCounts: Record<Tab, number>
  peopleOnlineCount: number | null
}) {
  const { tab, setTab } = useAppStore()
  const reduced = useReducedMotion() ?? false
  return (
    <aside className="hidden md:flex flex-col w-60 shrink-0 border-r bg-sidebar h-[calc(100vh-var(--header-h,3.5rem))] sticky top-[var(--header-h,3.5rem)]">
      <nav aria-label="Main navigation" className="p-3 space-y-1">
        {NAV_ITEMS.map(({ tab: t, label, icon: Icon }) => {
          const active = tab === t
          const badgeCount = getBadgeCount(t, unread, activityCounts, peopleOnlineCount)
          return (
            <motion.button
              key={t}
              onClick={() => setTab(t)}
              aria-current={active ? 'page' : undefined}
              aria-label={t === 'people' && badgeCount !== null ? `${label}, ${badgeCount} online` : label}
              whileTap={reduced ? undefined : { scale: 0.97 }}
              transition={TAP_SPRING}
              className={cn(
                'relative w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'
              )}
            >
              <Icon className="h-5 w-5" />
              {label}
              {badgeCount !== null && (
                <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                  {badgeCount > 99 ? '99+' : badgeCount}
                </span>
              )}
              {active && (
                <motion.span
                  layoutId="nav-side-pill"
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-0.5 rounded-full bg-primary"
                  transition={reduced ? { duration: 0 } : PILL_SPRING}
                />
              )}
            </motion.button>
          )
        })}
      </nav>
      <div className="mt-auto p-4 text-[11px] text-muted-foreground leading-relaxed">
        Hushly · quiet by design
        <br />
        13+ · be kind, report abuse
      </div>
    </aside>
  )
}
