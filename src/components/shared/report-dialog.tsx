"use client";

import { useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ShieldAlert } from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'

const REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'spam', label: 'Spam or scams' },
  { value: 'inappropriate_content', label: 'Inappropriate content' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'underage', label: 'Underage user (under 13)' },
  { value: 'other', label: 'Something else' },
]

export function ReportDialog({
  open,
  onOpenChange,
  publicId,
  postId,
  conversationId,
  label,
  onBlockedOptional,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  publicId?: string
  postId?: string
  conversationId?: string
  label?: string
  /** Optionally also block in the same flow */
  onBlockedOptional?: () => void
}) {
  const [reason, setReason] = useState('harassment')
  const [details, setDetails] = useState('')
  const [alsoBlock, setAlsoBlock] = useState(true)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      const res = await api.report({ publicId, postId, conversationId, reason, details: details || undefined })
      if (alsoBlock && publicId) {
        await api.blockUser(publicId).catch(() => undefined)
        onBlockedOptional?.()
      }
      toast.success(res.message)
      onOpenChange(false)
      setDetails('')
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not submit the report.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" /> Report {label ?? 'user'}
          </DialogTitle>
          <DialogDescription>
            Reports are reviewed by moderators. Your identity stays anonymous.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup value={reason} onValueChange={setReason} className="gap-2">
          {REASONS.map((r) => (
            <Label
              key={r.value}
              htmlFor={`reason-${r.value}`}
              className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem value={r.value} id={`reason-${r.value}`} />
              <span className="text-sm">{r.label}</span>
            </Label>
          ))}
        </RadioGroup>

        <div className="space-y-1.5">
          <Label htmlFor="report-details" className="text-xs text-muted-foreground">
            Details (optional)
          </Label>
          <Textarea
            id="report-details"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="What happened?"
            rows={3}
            maxLength={1000}
          />
        </div>

        {publicId && !postId && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={alsoBlock}
              onChange={(e) => setAlsoBlock(e.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Also block this user
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit report'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
