"use client";

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MessagesSquare, Clock3, KeyRound, Star, UsersRound } from 'lucide-react'
import { api } from '@/lib/client-api'
import { useAppStore } from '@/store/app-store'
import { UserAvatar } from '@/components/shared/user-avatar'
import { ExpirationBadge, shortTime } from '@/components/shared/bits'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { CodeSearchDialog } from '@/components/screens/code-search-dialog'
import { GroupCreateDialog } from '@/components/screens/group-create-dialog'
import type { ConversationSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

function previewText(t: { type: string; text: string | null }): string {
  if (t.type === 'image') return t.text ? `Photo · ${t.text}` : 'Photo'
  if (t.type === 'video') return t.text ? `Video · ${t.text}` : 'Video'
  return t.text ?? ''
}

/** Row preview text; groups get a "Sender: …" prefix like WhatsApp. */
function rowPreview(c: ConversationSummary, myPublicId: string | undefined): string {
  if (!c.lastMessage) return c.type === 'group' ? 'Say hi — no messages yet' : 'Say hi — no messages yet'
  const body = previewText(c.lastMessage) || 'Media message'
  if (c.type === 'group') {
    if (c.lastMessage.type === 'system') return body
    const who =
      c.lastMessage.senderPublicId === myPublicId
        ? 'You'
        : (c.members.find((m) => m.publicId === c.lastMessage?.senderPublicId)?.displayName ?? '')
    return who ? `${who}: ${body}` : body
  }
  return c.lastMessage.senderPublicId === c.other?.publicId ? body : `You: ${body}`
}

export function ChatsScreen() {
  const openConversation = useAppStore((s) => s.openConversation)
  const myPublicId = useAppStore((s) => s.profile?.publicId)
  const [codeOpen, setCodeOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: api.getConversations,
    refetchInterval: 30_000,
  })

  // Favourited users always float to the top (server sorts too; this keeps the
  // client resilient), then most recently active.
  const list = useMemo(() => {
    const items = [...(conversations.data?.conversations ?? [])]
    items.sort((a, b) => {
      const fa = a.other?.favorited ? 1 : 0
      const fb = b.other?.favorited ? 1 : 0
      if (fa !== fb) return fb - fa
      return a.updatedAt < b.updatedAt ? 1 : -1
    })
    return items
  }, [conversations.data])
  const favCount = list.filter((c) => c.other?.favorited).length

  return (
    <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto p-4 sm:p-6 gap-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-primary/12 text-primary ring-1 ring-primary/15">
              <MessagesSquare className="h-5 w-5" aria-hidden />
            </span>
            Chats
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Your people, your conversations. Favourites stay close 💬
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setGroupOpen(true)}
            aria-label="Create a group"
            title="Create a group"
          >
            <UsersRound className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCodeOpen(true)}
            aria-label="Find someone by invite code"
            title="Find someone by invite code"
          >
            <KeyRound className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {conversations.isLoading ? (
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
          ))}
        </div>
      ) : conversations.isError ? (
        <Card>
          <CardContent className="p-6 text-center space-y-2">
            <p className="text-sm text-muted-foreground">Could not load your chats.</p>
            <button className="text-sm text-primary underline" onClick={() => conversations.refetch()}>
              Retry
            </button>
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Clock3 className="h-10 w-10 mx-auto text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
              No conversations yet. Say hi to someone in <strong>People</strong>, look around{' '}
              <strong>Nearby</strong>, enter a friend's <strong>invite code</strong>, or start a{' '}
              <strong>group</strong>.
            </p>
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={() => setGroupOpen(true)}>
                <UsersRound className="h-4 w-4" aria-hidden />
                New group
              </Button>
              <Button variant="outline" onClick={() => setCodeOpen(true)}>
                <KeyRound className="h-4 w-4" aria-hidden />
                Use an invite code
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2.5" aria-label="Conversation list">
          {favCount > 0 && (
            <li className="flex items-center gap-1.5 px-1 pt-1 text-[10px] uppercase tracking-wide text-muted-foreground/80" aria-hidden>
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> Favourites
            </li>
          )}
          {list.map((c, idx) => {
            const isGroup = c.type === 'group'
            const name = isGroup ? (c.name ?? 'Group') : (c.other?.nickname ?? c.other?.displayName ?? 'Chat')
            const favorited = Boolean(c.other?.favorited)
            const prev = list[idx - 1]
            const showSecondHeader = favCount > 0 && favorited === false && prev?.other?.favorited === true
            return (
              <li key={c.id}>
                {showSecondHeader && (
                  <p className="px-1 pb-1 pt-3 text-[10px] uppercase tracking-wide text-muted-foreground/80" aria-hidden>
                    All chats
                  </p>
                )}
                <button
                  className="w-full text-left"
                  onClick={() => openConversation(c.id)}
                  aria-label={isGroup ? `Open group ${name}` : `Open chat with ${name}`}
                >
                  <Card
                    className={cn(
                      'border-border/70 bg-card/70 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card hover:shadow-md active:translate-y-0 active:scale-[0.995]',
                      c.unreadCount > 0 && 'border-primary/40 bg-primary/[0.055]'
                    )}
                  >
                    <CardContent className="p-3.5 sm:p-4 flex items-center gap-3.5">
                      {isGroup ? (
                        <div className="relative shrink-0">
                          <UserAvatar
                            displayName={name}
                            publicId={`group:${c.id}`}
                            avatarUrl={null}
                            size={46}
                          />
                          <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-background border flex items-center justify-center" aria-hidden>
                            <UsersRound className="h-2.5 w-2.5 text-muted-foreground" />
                          </span>
                        </div>
                      ) : (
                        <UserAvatar
                          displayName={name}
                          publicId={c.other?.publicId ?? ''}
                          avatarUrl={c.other?.avatarUrl}
                          online={c.other?.online}
                          size={46}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {favorited && (
                            <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Favourite" />
                          )}
                          <p className="font-medium truncate">{name}</p>
                          {!isGroup && c.other?.nickname && (
                            <span className="text-[10px] text-muted-foreground truncate">
                              ({c.other.displayName})
                            </span>
                          )}
                          <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
                            {c.lastMessage ? shortTime(c.lastMessage.createdAt) : ''}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <p
                            className={cn(
                              'text-xs truncate',
                              c.unreadCount > 0 ? 'text-foreground font-medium' : 'text-muted-foreground'
                            )}
                          >
                            {c.lastMessage || c.unreadCount > 0
                              ? rowPreview(c, myPublicId)
                              : isGroup
                                ? `${c.members.length + 1} members — say hi`
                                : 'Say hi — no messages yet'}
                          </p>
                          {c.unreadCount > 0 && (
                            <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center shrink-0">
                              {c.unreadCount > 99 ? '99+' : c.unreadCount}
                            </span>
                          )}
                          {!c.lastMessage && c.unreadCount === 0 && !isGroup && (
                            <span className="ml-auto shrink-0">
                              <ExpirationBadge
                                policy={c.expirationPolicy}
                                expiresAt={c.expiresAt}
                                expiresSoon={c.expiresSoon}
                              />
                            </span>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <CodeSearchDialog open={codeOpen} onClose={() => setCodeOpen(false)} />
      <GroupCreateDialog open={groupOpen} onClose={() => setGroupOpen(false)} />
    </div>
  )
}
