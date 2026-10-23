"use client";

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Ban, Loader2, ShieldOff } from 'lucide-react'
import { api, ApiClientError } from '@/lib/client-api'
import { UserAvatar } from '@/components/shared/user-avatar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { relativeTime } from './profile-bits'
import type { BlockDTO } from '@/lib/types'

/**
 * Users I have blocked. Blocked users cannot message me, match with me or
 * see my stories; unblocking takes effect immediately.
 */
export function BlockedUsersCard() {
  const queryClient = useQueryClient()
  const blocksQuery = useQuery({ queryKey: ['blocks'], queryFn: api.getBlocks, staleTime: 15_000 })
  const [unblocking, setUnblocking] = useState<string | null>(null)

  async function unblock(target: BlockDTO) {
    setUnblocking(target.publicId)
    try {
      await api.unblockUser(target.publicId)
      await queryClient.invalidateQueries({ queryKey: ['blocks'] })
      toast.success(`Unblocked ${target.displayName}.`)
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Could not unblock this user.')
    } finally {
      setUnblocking(null)
    }
  }

  const blocks = blocksQuery.data?.blocks ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Ban className="h-4 w-4 text-muted-foreground" aria-hidden /> Blocked users
        </CardTitle>
        <CardDescription>
          Blocked people cannot message you, match with you or see your stories.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {blocksQuery.isLoading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : blocks.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No blocked users
          </p>
        ) : (
          <ul className="divide-y">
            {blocks.map((block) => (
              <li key={block.publicId} className="flex items-center gap-3 py-2.5">
                <UserAvatar
                  displayName={block.displayName}
                  publicId={block.publicId}
                  avatarUrl={block.avatarUrl}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{block.displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    Blocked {relativeTime(block.blockedAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={unblocking === block.publicId}
                  onClick={() => void unblock(block)}
                >
                  {unblocking === block.publicId ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldOff className="h-4 w-4" aria-hidden />
                  )}
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
