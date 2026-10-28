'use client'

import { useEffect } from 'react'
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
} from 'firebase/firestore'
import { signInWithCustomToken } from 'firebase/auth'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { getFirebaseClientAuth, getFirebaseClientFirestore } from '@/lib/firebase-client'
import { useAppStore } from '@/store/app-store'
import type { ConversationSummary, MessageDTO } from '@/lib/types'

type RealtimeEvent = {
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
      queryClient.invalidateQueries({ queryKey: ['messages', message.conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
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
      return
    case 'feed:update':
      queryClient.invalidateQueries({ queryKey: ['posts'] })
      if (payload.postId) {
        queryClient.invalidateQueries({ queryKey: ['post-thread', payload.postId] })
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
  const eventsQuery = query(collectionRef, orderBy('createdAt', 'desc'), limit(50))
  let initialSnapshot = true

  return onSnapshot(
    eventsQuery,
    (snapshot) => {
      if (initialSnapshot) {
        initialSnapshot = false
        return
      }
      for (const change of snapshot.docChanges()) {
        if (change.type !== 'added') continue
        const data = change.doc.data()
        if (typeof data.event !== 'string' || typeof data.payload !== 'object' || !data.payload) {
          console.error('[realtime] Ignoring malformed Firebase event:', change.doc.id)
          continue
        }
        onEvent({ event: data.event, payload: data.payload as DocumentData })
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

    void (async () => {
      try {
        const auth = getFirebaseClientAuth()
        const credential = await signInWithCustomToken(auth, firebaseToken)
        if (!active) return

        const handleEvent = ({ event, payload }: RealtimeEvent) => {
          if (useAppStore.getState().socketConnected) return
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
        stopBroadcastEvents = attachEventListener(
          ['realtimeBroadcasts'],
          handleEvent,
          onError,
        )
        onConnectionChange?.(true)
      } catch (error) {
        console.error('[realtime] Firebase authentication failed:', error)
        onConnectionChange?.(false)
      }
    })()

    return () => {
      active = false
      stopUserEvents?.()
      stopBroadcastEvents?.()
      onConnectionChange?.(false)
    }
  }, [firebaseToken, queryClient, onConnectionChange])
}

