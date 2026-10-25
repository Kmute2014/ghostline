"use client";

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { AnimatePresence, motion, type Transition, type Variants } from 'framer-motion'
import { ArrowLeft, KeyRound, Loader2, Search, UsersRound } from 'lucide-react'
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
import { ExpirationPicker } from '@/components/shared/expiration-dialog'
import { UserAvatar } from '@/components/shared/user-avatar'
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import type { ExpirationPolicyDTO, InviteLookup, InviteLookupResponse } from '@/lib/types'

const spring: Transition = { type: 'spring', stiffness: 400, damping: 34 }

type Step = 'input' | 'found'

const stepVariants: Variants = {
  enter: (dir: number) => ({ x: 36 * dir, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: -36 * dir, opacity: 0 }),
}

/** "about 2 hours ago" style label for a last-seen timestamp. */
function lastSeenLabel(iso: string | null): string {
  if (!iso) return 'a while ago'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return 'a while ago'
  }
}

/**
 * In-app invite-code search: enter someone's code, preview who it belongs to,
 * pick an expiration policy, and connect straight into the chat. Mirrors the
 * deep-link InviteDialog flow but starts from a code the user typed or received.
 */
export function CodeSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const openConversation = useAppStore((s) => s.openConversation)

  const [step, setStep] = useState<Step>('input')
  const [dir, setDir] = useState(1)
  const [code, setCode] = useState('')
  const [found, setFound] = useState<InviteLookup | null>(null)
  const [foundGroup, setFoundGroup] = useState<{ name: string; memberCount: number; isMember: boolean } | null>(null)
  const [foundCode, setFoundCode] = useState('') // the normalized code that resolved
  const [policy, setPolicy] = useState<ExpirationPolicyDTO>('24h')
  const [searching, setSearching] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Every open starts a fresh search.
  useEffect(() => {
    if (open) {
      setStep('input')
      setDir(1)
      setCode('')
      setFound(null)
      setFoundGroup(null)
      setFoundCode('')
      setPolicy('24h')
      setSearching(false)
      setConnecting(false)
      setError(null)
    }
  }, [open])

  const normalized = code.trim().toUpperCase().replace(/\s+/g, '')
  const canSearch = normalized.length >= 7 && !searching

  async function lookup() {
    if (normalized.length < 7 || searching) return
    setSearching(true)
    setError(null)
    try {
      const res = await api.lookupInvite(normalized)
      setFound(res.type === 'user' ? res.profile : null)
      setFoundGroup(res.type === 'group' ? res.group : null)
      setFoundCode(normalized)
      setDir(1)
      setStep('found')
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not look up that code.')
    } finally {
      setSearching(false)
    }
  }

  function back() {
    setDir(-1)
    setFound(null)
    setFoundGroup(null)
    setError(null)
    setStep('input')
  }

  async function connect() {
    if (connecting) return
    setConnecting(true)
    setError(null)
    try {
      // Group codes join the group; user codes open a direct chat.
      if (foundGroup) {
        const res = await api.joinGroup(foundCode)
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        openConversation(res.conversation.id)
        onClose()
        return
      }
      if (!found) return
      const res = await api.redeemInvite(foundCode, policy)
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      openConversation(res.conversation.id)
      onClose()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not start the chat.')
      setConnecting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" aria-hidden /> Find someone by invite code
          </DialogTitle>
          <DialogDescription>
            Enter a friend's code to preview who it belongs to, then choose how long the chat
            lives. Blocks still apply.
          </DialogDescription>
        </DialogHeader>

        {/* Step area — push-slide between input and preview (padding trick keeps focus rings unclipped) */}
        <div className="relative overflow-hidden px-1 -mx-1">
          <AnimatePresence mode="popLayout" custom={dir} initial={false}>
            {step === 'input' ? (
              <motion.div
                key="input"
                custom={dir}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={spring}
                className="space-y-1.5"
              >
                <label
                  htmlFor="code-search-input"
                  className="text-sm font-medium flex items-center gap-1.5"
                >
                  <Search className="h-4 w-4" aria-hidden /> Invite code
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="code-search-input"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void lookup()
                      }
                    }}
                    placeholder="XK7Q-2M9P"
                    maxLength={12}
                    className="font-mono tracking-widest uppercase"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={!!error}
                  />
                  <motion.div whileTap={{ scale: 0.98 }} className="shrink-0">
                    <Button onClick={() => void lookup()} disabled={!canSearch}>
                      {searching ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Search className="h-4 w-4" aria-hidden />
                      )}
                      {searching ? 'Searching…' : 'Find'}
                    </Button>
                  </motion.div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Codes look like XK7Q-2M9P — with or without the dash, uppercase or not.
                </p>
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </motion.div>
            ) : foundGroup ? (
              <motion.div
                key="found"
                custom={dir}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={spring}
                className="space-y-4"
              >
                {/* Group preview card */}
                <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3.5">
                  <span
                    className="flex h-13 w-13 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary"
                    aria-hidden
                  >
                    <UsersRound className="h-6 w-6" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold truncate">{foundGroup.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {foundGroup.memberCount} member{foundGroup.memberCount === 1 ? '' : 's'}
                      {foundGroup.isMember ? ' · you are already in this group' : ' · group invite'}
                    </p>
                  </div>
                </div>

                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </motion.div>
            ) : found ? (
              <motion.div
                key="found"
                custom={dir}
                variants={stepVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={spring}
                className="space-y-4"
              >
                {/* Preview card */}
                <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3.5">
                  <UserAvatar
                    displayName={found.displayName}
                    publicId={found.publicId}
                    avatarUrl={found.avatarUrl}
                    online={found.online}
                    size={52}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold truncate">{found.displayName}</p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      {found.online ? (
                        <>
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"
                            aria-hidden
                          />
                          Online now
                        </>
                      ) : (
                        <span>Last seen {lastSeenLabel(found.lastSeenAt)}</span>
                      )}
                    </p>
                    <p className="text-[11px] font-mono text-muted-foreground/70 mt-0.5">
                      {found.publicId}
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-sm font-medium">This chat should disappear after…</p>
                  <ExpirationPicker value={policy} onChange={setPolicy} />
                </div>

                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <DialogFooter>
          {step === 'found' ? (
            <Button variant="ghost" onClick={back} disabled={connecting}>
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose} disabled={searching}>
              Not now
            </Button>
          )}
          {step === 'found' && (
            <motion.div whileTap={{ scale: 0.98 }}>
              <Button onClick={() => void connect()} disabled={connecting}>
                {connecting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {connecting
                  ? foundGroup
                    ? 'Joining…'
                    : 'Connecting…'
                  : foundGroup
                    ? foundGroup.isMember
                      ? 'Open group'
                      : 'Join group'
                    : 'Connect'}
              </Button>
            </motion.div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
