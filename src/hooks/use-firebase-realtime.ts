'use client'

import { useEffect } from 'react'
import {
  collection,
  Timestamp,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
} from 'firebase/firestore'
import { signInWithCustomToken } from 'firebase/auth'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { getFirebaseClientAuth, getFirebaseClientFirestore } from '@/lib/firebase-client'
import { useAppStore } from '@/store/app-store'
import type { ConversationSummary, MessageDTO } from '@/lib/types'

type RealtimeEvent = {
  id: string
  event: string
  payload: DocumentData
}

function processEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  event: string,
  payload: DocumentData,
) {
  switch (event) {
    case 'message:new': {
      const message = payload as MessageDTO
      const normalizeDate = (value: unknown): unknown => {
        if (value instanceof Date) return value.toISOString()

        if (value && typeof value === 'object') {
          const timestamp = value as { toDate?: () => Date; seconds?: number }

          if (typeof timestamp.toDate === 'function') {
            return timestamp.toDate().toISOString()
          }

          if (typeof timestamp.seconds === 'number') {
            return new Date(timestamp.seconds * 1000).toISOString()
          }
        }

        return value
      }

      const toMillis = (value: unknown): number => {
        const normalized = normalizeDate(value)

        if (typeof normalized === 'number') return normalized

        if (typeof normalized === 'string') {
          const milliseconds = Date.parse(normalized)
          return Number.isFinite(milliseconds) ? milliseconds : 0
        }

        return 0
      }

      const cacheMessage = {
        ...message,
        createdAt: normalizeDate(message.createdAt),
        editedAt: normalizeDate(message.editedAt),
      } as MessageDTO

      const currentProfileId = useAppStore.getState().profile?.publicId
      const isFromCurrentUser = message.senderPublicId === currentProfileId
      const isCurrentlyReading =
        useAppStore.getState().activeConversationId === message.conversationId &&
        document.visibilityState === 'visible'

      let messageAlreadyCached = false

      queryClient.setQueryData<any>(
        ['messages', message.conversationId],
        (old) => {
          if (!old || !Array.isArray(old.pages) || old.pages.length === 0) {
            return old
          }

          messageAlreadyCached = old.pages.some(
            (page: any) =>
              Array.isArray(page.messages) &&
              page.messages.some(
                (item: any) =>
                  item.id === cacheMessage.id ||
                  (cacheMessage.clientId && item.clientId === cacheMessage.clientId),
              ),
          )

          if (messageAlreadyCached) return old

          const pages = [...old.pages]
          const firstPage = pages[0]
          const currentMessages = Array.isArray(firstPage.messages)
            ? firstPage.messages
            : []

          pages[0] = {
            ...firstPage,
            messages: [...currentMessages, cacheMessage].sort(
              (first: any, second: any) =>
                toMillis(second.createdAt) - toMillis(first.createdAt),
            ),
          }

          return { ...old, pages }
        },
      )

      queryClient.setQueryData<any>(
        ['conversations'],
        (old) => {
          if (!old || !Array.isArray(old.conversations)) return old

          let found = false

          const conversations = old.conversations.map((conversation: any) => {
            if (conversation.id !== message.conversationId) return conversation

            found = true

            const updated = {
              ...conversation,
              updatedAt: cacheMessage.createdAt,
              lastMessage: cacheMessage,
            }

            if ('lastMessageAt' in conversation) {
              updated.lastMessageAt = cacheMessage.createdAt
            }

            if ('lastMessagePreview' in conversation) {
              updated.lastMessagePreview =
                message.type === 'image'
                  ? 'Sent a photo'
                  : message.type === 'video'
                    ? 'Sent a video'
                    : message.text ?? 'New message'
            }

            if (typeof conversation.unreadCount === 'number') {
              if (isCurrentlyReading) {
                updated.unreadCount = 0
              } else if (!isFromCurrentUser && !messageAlreadyCached) {
                updated.unreadCount = conversation.unreadCount + 1
              }
            }

            return updated
          })

          if (!found) return old

          conversations.sort(
            (first: any, second: any) =>
              toMillis(second.updatedAt) - toMillis(first.updatedAt),
          )

          return { ...old, conversations }
        },
      )
      if (message.senderPublicId === useAppStore.getState().profile?.publicId) return
      if (
        useAppStore.getState().activeConversationId === message.conversationId &&
        document.visibilityState === 'visible'
      ) {
        void fetch(`/api/conversations/${message.conversationId}/read`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch((error: unknown) => console.error('[realtime] read receipt request failed:', error))
        return
      }

      const conversations = queryClient.getQueryData<{ conversations: ConversationSummary[] }>([
        'conversations',
      ])
      const conversation = conversations?.conversations.find(
        (item) => item.id === message.conversationId,
      )
      const sender = conversation
        ? conversation.type === 'group'
          ? conversation.name ?? 'Group chat'
          : conversation.other?.nickname ?? conversation.other?.displayName ?? 'Someone'
        : 'Someone'
      const preview =
        message.type === 'text'
          ? message.text ?? ''
          : message.type === 'image'
            ? 'Sent a photo'
            : message.type === 'video'
              ? 'Sent a video'
              : 'New message'
      toast(`${sender}: ${preview}`, {
        description: 'Open Chats to reply',
        action: {
          label: 'Open',
          onClick: () => useAppStore.getState().openConversation(message.conversationId),
        },
      })
      return
    }
    case 'conversation:new':
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (payload.conversationId !== useAppStore.getState().activeConversationId) {
        toast(payload.groupName ? `Added to â€œ${payload.groupName}â€` : 'New conversation started', {
          description: 'Open Chats to say hello.',
        })
      }
      return
    case 'conversation:updated':
    case 'conversation:deleted':
    case 'conversation:read':
    case 'message:changed':
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (payload.conversationId) {
        queryClient.invalidateQueries({ queryKey: ['conversation', payload.conversationId] })
        queryClient.invalidateQueries({ queryKey: ['messages', payload.conversationId] })
      }
      return
    case 'presence:update':
      queryClient.invalidateQueries({ queryKey: ['people'] })
      queryClient.invalidateQueries({ queryKey: ['nearby'] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['contacts'] })
      if (
        payload.online === true &&
        typeof payload.publicId === 'string' &&
        typeof payload.lastSeenAt === 'string' &&
        useAppStore.getState().tab !== 'people'
      ) {
        useAppStore.getState().incrementActivity('people', `${payload.publicId}:${payload.lastSeenAt}`)
      }
      return
    case 'feed:update':
      queryClient.invalidateQueries({ queryKey: ['posts'] })
      if (payload.postId) {
        queryClient.invalidateQueries({ queryKey: ['post-thread', payload.postId] })
      }
      if (
        payload.reason === 'post' &&
        typeof payload.postId === 'string' &&
        useAppStore.getState().tab !== 'feed'
      ) {
        useAppStore.getState().incrementActivity('feed', payload.postId)
      }
      return
    case 'stories:update':
      queryClient.invalidateQueries({ queryKey: ['stories'] })
      if (
        typeof payload.storyId === 'string' &&
        useAppStore.getState().tab !== 'stories'
      ) {
        useAppStore.getState().incrementActivity('stories', payload.storyId)
      }
      return
    case 'buzz:notification':
      queryClient.invalidateQueries({ queryKey: ['posts'] })
      if (payload.postId) {
        queryClient.invalidateQueries({ queryKey: ['post-thread', payload.postId] })
      }
      toast(payload.title ?? 'Buzz', {
        description: payload.body ?? 'There is new activity on a post you contributed to.',
        action: {
          label: 'Open Buzz',
          onClick: () => useAppStore.getState().setTab('feed'),
        },
      })
  }
}

function attachEventListener(
  collectionPath: string[],
  onEvent: (event: RealtimeEvent) => void,
  onError: (error: Error) => void,
) {
  const collectionRef = collection(getFirebaseClientFirestore(), collectionPath.join('/'))
  const startedAt = Timestamp.fromMillis(Date.now() - 2_000)
  const eventsQuery = collectionPath[0] === 'realtimeBroadcasts'
    ? query(
        collectionRef,
        where('room', '==', 'feed'),
        where('createdAt', '>=', startedAt),
        orderBy('createdAt', 'desc'),
        limit(50),
      )
    : query(
        collectionRef,
        where('createdAt', '>=', startedAt),
        orderBy('createdAt', 'desc'),
        limit(50),
      )

  return onSnapshot(
    eventsQuery,
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue

        const data = change.doc.data()
        if (typeof data.event !== 'string' || typeof data.payload !== 'object' || !data.payload) {
          console.error('[realtime] Ignoring malformed Firebase event:', change.doc.id)
          continue
        }

        onEvent({
          id: collectionPath.join('/') + '/' + change.doc.id,
          event: data.event,
          payload: data.payload as DocumentData,
        })
      }
    },
    onError,
  )
}
export function useFirebaseRealtime(firebaseToken: string | null | undefined, onConnectionChange?: (connected: boolean) => void) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!firebaseToken) {
      onConnectionChange?.(false)
      return
    }
    onConnectionChange?.(false)

    let active = true
    let stopUserEvents: (() => void) | undefined
    let stopBroadcastEvents: (() => void) | undefined
    let unsubscribeStore: (() => void) | undefined

    void (async () => {
      try {
        const auth = getFirebaseClientAuth()
        const credential = await signInWithCustomToken(auth, firebaseToken)
        if (!active) return

                const seenEventIds = new Set<string>()
        const handleEvent = ({ id, event, payload }: RealtimeEvent) => {
          if (useAppStore.getState().socketConnected) return
          if (seenEventIds.has(id)) return

          seenEventIds.add(id)
          if (seenEventIds.size > 2000) {
            const oldest = seenEventIds.values().next().value
            if (typeof oldest === 'string') seenEventIds.delete(oldest)
          }

          processEvent(queryClient, event, payload)
        }
        const onError = (error: Error) => {
          console.error('[realtime] Firebase event listener failed:', error)
          onConnectionChange?.(false)
        }

                stopUserEvents = attachEventListener(
          ['realtimeUsers', credential.user.uid, 'events'],
          handleEvent,
          onError,
        )

        const syncBroadcastListener = (refreshPosts: boolean) => {
          const shouldListenToFeed = useAppStore.getState().tab === 'feed'

          if (shouldListenToFeed && !stopBroadcastEvents) {
            stopBroadcastEvents = attachEventListener(
              ['realtimeBroadcasts'],
              handleEvent,
              onError,
            )

            if (refreshPosts) {
              void queryClient.invalidateQueries({ queryKey: ['posts'] })
            }
          } else if (!shouldListenToFeed && stopBroadcastEvents) {
            stopBroadcastEvents()
            stopBroadcastEvents = undefined
          }
        }

        unsubscribeStore = useAppStore.subscribe((state, previousState) => {
          if (state.tab !== previousState.tab) {
            syncBroadcastListener(
              previousState.tab !== 'feed' && state.tab === 'feed',
            )
          }
        })

        syncBroadcastListener(false)
        onConnectionChange?.(true)
      } catch (error) {
        console.error('[realtime] Firebase authentication failed:', error)
        onConnectionChange?.(false)
      }
    })()

    return () => {
      active = false
      unsubscribeStore?.()
      stopUserEvents?.()
      stopBroadcastEvents?.()
      onConnectionChange?.(false)
    }
  }, [firebaseToken, queryClient, onConnectionChange])
}
