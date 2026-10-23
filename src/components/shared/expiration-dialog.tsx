"use client";

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Clock, CalendarClock, Infinity as InfinityIcon } from 'lucide-react'
import type { ExpirationPolicyDTO } from '@/lib/types'

export function ExpirationPicker({
  value,
  onChange,
}: {
  value: ExpirationPolicyDTO
  onChange: (v: ExpirationPolicyDTO) => void
}) {
  const options: { value: ExpirationPolicyDTO; label: string; desc: string; icon: React.ReactNode }[] = [
    {
      value: '24h',
      label: '24 hours',
      desc: 'Vanishes one day after creation',
      icon: <Clock className="h-4 w-4" />,
    },
    {
      value: '3months',
      label: '3 months',
      desc: 'Kept for a season, then removed',
      icon: <CalendarClock className="h-4 w-4" />,
    },
    {
      value: 'never',
      label: 'Never expire',
      desc: 'Stays until someone deletes or ends it',
      icon: <InfinityIcon className="h-4 w-4" />,
    },
  ]

  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as ExpirationPolicyDTO)} className="gap-2">
      {options.map((o) => (
        <Label
          key={o.value}
          htmlFor={`exp-${o.value}`}
          className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer has-[[data-state=checked]]:border-primary"
        >
          <RadioGroupItem value={o.value} id={`exp-${o.value}`} />
          <span className="flex items-center gap-2 text-sm font-medium">{o.icon} {o.label}</span>
          <span className="ml-auto text-xs text-muted-foreground text-right hidden sm:block">{o.desc}</span>
        </Label>
      ))}
    </RadioGroup>
  )
}

/** Dialog wrapper used when initiating a direct conversation or redeeming an invite. */
export function ExpirationDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Start chat',
  busy,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  busy?: boolean
  onConfirm: (policy: ExpirationPolicyDTO) => void
}) {
  const [policy, setPolicy] = useState<ExpirationPolicyDTO>('never')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ExpirationPicker value={policy} onChange={setPolicy} />
        <p className="text-xs text-muted-foreground">
          This applies to the whole conversation. Either participant can change it later in chat settings —
          changes notify everyone.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(policy)} disabled={busy}>
            {busy ? 'Creating…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
