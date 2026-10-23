"use client";

import { useState } from 'react'
import { Ghost, MapPin, MessageCircle, Sparkles, ShieldCheck, KeyRound } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { api, ApiClientError } from '@/lib/client-api'
import type { SessionResponse } from '@/lib/types'

/**
 * First-visit onboarding: instant anonymous identity — no phone, email or
 * password. Explains privacy + location behavior before any permission ask.
 */
export function Onboarding({ onReady }: { onReady: (data: SessionResponse) => void }) {
  const reduced = useReducedMotion() ?? false
  const [mode, setMode] = useState<'intro' | 'recover'>('intro')
  const [name, setName] = useState(`Ghost-${Math.floor(1000 + Math.random() * 9000)}`)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setBusy(true)
    setError(null)
    try {
      const data = await api.createIdentity(name)
      onReady(data)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create your identity.')
    } finally {
      setBusy(false)
    }
  }

  async function recover() {
    setBusy(true)
    setError(null)
    try {
      const data = await api.recoverIdentity(recoveryCode)
      onReady(data)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Recovery failed.')
    } finally {
      setBusy(false)
    }
  }

  const listVariants: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduced ? 0 : 0.03 } },
  }
  const itemVariants: Variants = {
    hidden: reduced ? { opacity: 0 } : { opacity: 0, y: 6 },
    show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 400, damping: 32 } },
  }

  return (
    <div className="app-shell flex flex-col items-center justify-center p-4 bg-[radial-gradient(60rem_40rem_at_50%_-10%,oklch(0.30_0.09_295/0.5),transparent)]">
      <motion.main
        className="w-full max-w-md space-y-6"
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 38, mass: 0.9 }}
      >
        <div className="text-center space-y-3">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/15 border border-primary/30 flex items-center justify-center">
            <Ghost className="h-9 w-9 text-primary" aria-hidden />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Ghostline</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            See everyone who's online and start chatting instantly, find people nearby, share
            24-hour stories and connect with invite codes — all without a phone number, email or
            password.
          </p>
        </div>

        <Card>
          <CardContent className="p-5">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={mode}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 38 }}
                className="space-y-4"
              >
            {mode === 'intro' ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="display-name">Pick a display name</Label>
                  <Input
                    id="display-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={24}
                    placeholder="Ghost-1234"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">You can change this anytime.</p>
                </div>

                <motion.ul
                  className="text-sm text-muted-foreground space-y-2.5 py-1"
                  variants={listVariants}
                  initial="hidden"
                  animate="show"
                >
                  <motion.li className="flex gap-2.5" variants={itemVariants}>
                    <ShieldCheck className="h-4 w-4 mt-0.5 text-primary shrink-0" aria-hidden />
                    No account needed. Your identity lives in this browser — write down your recovery
                    code later so you can restore it if this browser's storage is cleared.
                  </motion.li>
                  <motion.li className="flex gap-2.5" variants={itemVariants}>
                    <MapPin className="h-4 w-4 mt-0.5 text-primary shrink-0" aria-hidden />
                    Location is requested only if you turn on Nearby discovery. Others only ever see an
                    approximate distance — never your coordinates.
                  </motion.li>
                  <motion.li className="flex gap-2.5" variants={itemVariants}>
                    <MessageCircle className="h-4 w-4 mt-0.5 text-primary shrink-0" aria-hidden />
                    Chats can expire after 24 hours, 3 months, or never — you choose per conversation.
                  </motion.li>
                  <motion.li className="flex gap-2.5" variants={itemVariants}>
                    <Sparkles className="h-4 w-4 mt-0.5 text-primary shrink-0" aria-hidden />
                    Ghostline is for people aged 13 and over. Be kind — blocking and reporting are one
                    tap away.
                  </motion.li>
                </motion.ul>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <motion.div
                  whileTap={reduced ? undefined : { scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                  <Button className="w-full" size="lg" onClick={start} disabled={busy}>
                    {busy ? 'Creating your identity…' : 'Enter Ghostline'}
                  </Button>
                </motion.div>
                <button
                  type="button"
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode('recover')}
                >
                  I have a recovery code from another device
                </button>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="recovery" className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" /> Recovery code
                  </Label>
                  <Input
                    id="recovery"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value)}
                    placeholder="RXXXXX-XXXXX-XXXXX"
                    className="font-mono"
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Restoring links this browser to your previous identity. Anonymous identities that
                    were never backed up with a recovery code cannot be recovered.
                  </p>
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <motion.div
                  whileTap={reduced ? undefined : { scale: 0.98 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                >
                  <Button className="w-full" onClick={recover} disabled={busy || recoveryCode.trim().length < 6}>
                    {busy ? 'Recovering…' : 'Restore identity'}
                  </Button>
                </motion.div>
                <button
                  type="button"
                  className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode('intro')}
                >
                  Start fresh instead
                </button>
              </>
            )}
              </motion.div>
            </AnimatePresence>
          </CardContent>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground px-6">
          By entering you agree to treat others with respect. Messages are not end-to-end encrypted;
          they travel over an encrypted connection and are stored until they expire.
        </p>
      </motion.main>
    </div>
  )
}
