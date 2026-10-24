"use client";

import { useMemo } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

const HUES = [215, 35, 255, 345, 230, 195]

function hashHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}

export function UserAvatar({
  displayName,
  publicId,
  avatarUrl,
  size = 40,
  online,
  className,
}: {
  displayName: string
  publicId: string
  avatarUrl?: string | null
  size?: number
  online?: boolean
  className?: string
}) {
  const hue = useMemo(() => hashHue(publicId || displayName || 'x'), [publicId, displayName])
  const initial = (displayName || '?').trim().charAt(0).toUpperCase()

  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }}>
      <Avatar className="h-full w-full" style={{ width: size, height: size }}>
        {avatarUrl ? (
          <AvatarImage src={avatarUrl} alt={`${displayName}'s avatar`} />
        ) : null}
        <AvatarFallback
          className="font-semibold text-white select-none"
          style={{
            background: `linear-gradient(135deg, oklch(0.55 0.19 ${hue}), oklch(0.42 0.14 ${(hue + 40) % 360}))`,
            fontSize: Math.max(11, size * 0.4),
          }}
        >
          {initial}
        </AvatarFallback>
      </Avatar>
      {online !== undefined && (
        <span
          aria-label={online ? 'Online' : 'Offline'}
          className={cn(
            'absolute bottom-0 right-0 block rounded-full border-2 border-background',
            online ? 'bg-emerald-400 signal-dot' : 'bg-muted-foreground/50'
          )}
          style={{ width: Math.max(9, size * 0.26), height: Math.max(9, size * 0.26) }}
        />
      )}
    </div>
  )
}
