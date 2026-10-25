"use client";

import { useCallback, useEffect, useState } from 'react'
import { Link2, UsersRound, Loader2 } from 'lucide-react'
import { HushlyMark } from '@/components/shared/hushly-mark'
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
import { api, ApiClientError } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import type { ExpirationPolicyDTO, InviteLookupResponse } from '@/lib/types'

/**
 * Shown when the app is opened with ?invite=CODE. The code is looked up
 * first: group codes (leading "G") show a group preview with a one-tap
 * "Join group"; user codes keep the classic flow — validate, choose an
 * expiration, and start the direct conversation. Blocks always apply.
 */
export function InviteDialog({ code, onClose }: { code: string; onClose: () => void }) {
  const openConversation = useAppStore((s) => s.openConversation)
  const [editableCode, setEditableCode] = useState(code)
  const [policy, setPolicy] = useState<ExpirationPolicyDTO>('never')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<InviteLookupResponse | null>(null)

  // Resolve the deep-linked code once so group invites can show what they
  // are before joining. User codes simply skip the preview (same as before).
  useEffect(() => {
    let cancelled = false
    const normalized = code.trim().toUpperCase().replace(/[\s-]+/g, '')
    if (normalized.length < 7) return
    api
      .lookupInvite(normalized)
      .then((res) => {
        if (!cancelled) setPreview(res)
      })
      .catch(() => {
        /* unknown code — the editable-code flow below still applies */
      })
    return () => {
      cancelled = true
    }
  }, [code])

  const connect = useCallback(async () => {
    setBusy(true)
    setError(null)
    const trimmed = editableCode.trim()
    try {
      // Group codes join the group; user codes open a direct chat.
      const normalized = trimmed.toUpperCase().replace(/[\s-]+/g, '')
      if (normalized.startsWith('G') && normalized.length === 9) {
        const res = await api.joinGroup(normalized)
        openConversation(res.conversation.id)
        onClose()
        return
      }
      const res = await api.redeemInvite(trimmed, policy)
      openConversation(res.conversation.id)
      onClose()
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'INVITE_NOT_FOUND') {
        // The user may have pasted a group code without the "G" being obvious —
        // try the group door before giving up.
        try {
          const res = await api.joinGroup(trimmed.toUpperCase().replace(/[\s-]+/g, ''))
          openConversation(res.conversation.id)
          onClose()
          return
        } catch {
          /* fall through to the original error */
        }
      }
      setError(err instanceof ApiClientError ? err.message : 'Could not use this invite.')
    } finally {
      setBusy(false)
    }
  }, [editableCode, policy, openConversation, onClose])

  const groupPreview = preview?.type === 'group' ? preview.group : null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        {groupPreview ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UsersRound className="h-5 w-5 text-primary" aria-hidden /> You&apos;re invited to a group
              </DialogTitle>
              <DialogDescription>
                Joining puts you in the conversation with everyone — you can leave anytime.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3.5">
              <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <UsersRound className="h-6 w-6" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="font-semibold truncate">{groupPreview.name}</p>
                <p className="text-xs text-muted-foreground">
                  {groupPreview.memberCount} member{groupPreview.memberCount === 1 ? '' : 's'}
                  {groupPreview.isMember ? ' · you are already in this group' : ''}
                </p>
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Not now
              </Button>
              <Button onClick={() => void connect()} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {busy
                  ? 'Joining…'
                  : groupPreview.isMember
                    ? 'Open group'
                    : 'Join group'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <HushlyMark className="h-5 w-5" /> Someone invited you
              </DialogTitle>
              <DialogDescription>
                Use their invite code to open a direct conversation. It works even if they turned off
                random chat — blocks still apply.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <label htmlFor="invite-code" className="text-sm font-medium flex items-center gap-1.5">
                <Link2 className="h-4 w-4" /> Invite code
              </label>
              <Input
                id="invite-code"
                value={editableCode}
                onChange={(e) => setEditableCode(e.target.value.toUpperCase())}
                className="font-mono tracking-widest"
                maxLength={12}
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">This chat should disappear after…</p>
              <ExpirationPicker value={policy} onChange={setPolicy} />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={onClose} disabled={busy}>
                Not now
              </Button>
              <Button onClick={() => void connect()} disabled={busy || editableCode.trim().length < 7}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
