"use client";

import { formatDistanceToNow, format, isToday, isYesterday } from 'date-fns'
import { Timer } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ExpirationPolicyDTO } from '@/lib/types'

export function lastSeenLabel(online: boolean, lastSeenAt: string | null): string {
  if (online) return 'Online'
  if (!lastSeenAt) return 'Offline'
  try {
    return `Last seen ${formatDistanceToNow(new Date(lastSeenAt), { addSuffix: true })}`
  } catch {
    return 'Offline'
  }
}

export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'd MMM, HH:mm')
}

export function countdownLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (remaining <= 0) return 'Expired'
  const mins = Math.floor(remaining / 60_000)
  if (mins < 60) return `${mins} min left`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} h left`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days} d left`
  return `${Math.floor(days / 30)} mo left`
}

export function ExpirationBadge({
  policy,
  expiresAt,
  expiresSoon,
  className,
}: {
  policy: ExpirationPolicyDTO
  expiresAt: string | null
  expiresSoon?: boolean
  className?: string
}) {
  if (policy === 'never') {
    return (
      <Badge variant="outline" className={cn('text-[10px] gap-1', className)}>
        <Timer className="h-3 w-3" /> Keeps history
      </Badge>
    )
  }
  const label = policy === '24h' ? '24 h chat' : '3-month chat'
  const remaining = countdownLabel(expiresAt)
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[10px] gap-1',
        expiresSoon ? 'border-amber-500/60 text-amber-400' : 'text-muted-foreground',
        className
      )}
    >
      <Timer className="h-3 w-3" />
      {remaining && expiresSoon ? remaining : label}
    </Badge>
  )
}
