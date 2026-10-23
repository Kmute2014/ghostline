"use client";

import { useCallback, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Copy text to the clipboard with a toast confirmation (legacy-browser fallback). */
export async function copyWithToast(text: string, message = 'Copied'): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    toast.success(message)
    return true
  } catch {
    toast.error('Could not copy to the clipboard.')
    return false
  }
}

/** "3 minutes ago" style label, or fallbacks for missing/invalid values. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never'
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true })
  } catch {
    return 'Unknown'
  }
}

/**
 * Mono value row (ids, codes, links) with a trailing copy button and an
 * optional slot for extra actions (e.g. Share) before the copy button.
 */
export function CodeRow({
  value,
  actions,
  className,
  copyLabel = 'Copied',
}: {
  value: string
  actions?: React.ReactNode
  className?: string
  copyLabel?: string
}) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async () => {
    const ok = await copyWithToast(value, copyLabel)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
  }, [value, copyLabel])

  return (
    <div className={cn('flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2', className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-sm tracking-wider" title={value}>
        {value}
      </code>
      {actions}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={() => void copy()}
        aria-label="Copy to clipboard"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  )
}
