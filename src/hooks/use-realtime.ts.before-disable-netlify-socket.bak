"use client";

import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getSocket } from '@/lib/socket-client'
import { useAppStore } from '@/store/app-store'
import type { ConversationSummary, MessageDTO } from '@/lib/types'

/**
 * Wires the realtime socket to the query cache and UI:
 * presence, incoming messages, Buzz activity, read receipts, and typing.
 */
export function useRealtime(socketToken: string | null | undefined, myPublicId: string | null) {
  const queryClient = useQueryClient()
  const activeConversationId = useAppStore((s) => s.activeConversationId)
  const closeConversation = useAppStore((s) => s.closeConversation)
  const setSocketConnected = useAppStore((s) => s.setSocketConnected)
  const setTab = useAppStore((s) => s.setTab)
  const setTyping = useAppStore((s) => s.setTyping)

  const activeRef = useRef(activeConversationId)
  const publicIdRef = useRef(myPublicId)
  useEffect(() => {
    activeRef.current = activeConversationId
  }, [activeConversationId])
  useEffect(() => {
    publicIdRef.current = myPublicId
  }, [myPublicId])

  useEffect(() => {
    if (!socketToken || !myPublicId) return
    const socket = getSocket(socketToken)

    const markRead = (conversationId: string) => {
      fetch(`/api/conversations/${conversationId}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => undefined)
    }

    const onConnect = () => {
      setSocketConnected(true)
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['nearby'] })
    }

    const subscribeConv = (conversationId?: string) => {
      if (conversationId) socket.emit('conversation:subscribe', { conversationId })
    }

    const onDisconnect = () => setSocketConnected(false)

    const onMessageNew = (msg: MessageDTO) => {
      queryClient.invalidateQueries({ queryKey: ['messages', msg.conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })

      if (msg.senderPublicId === publicIdRef.current) return

      if (activeRef.current === msg.conversationId && document.visibilityState === 'visible') {
        markRead(msg.conversationId)
      } else {
        // Friendly toast with a content preview
        const convs = queryClient.getQueryData<{ conversations: ConversationSummary[] }>(['conversations'])
        const conv = convs?.conversations.find((c) => c.id === msg.conversationId)
        const who = conv
          ? conv.type === 'group'
            ? (conv.name ?? 'Group chat')
            : (conv.other?.nickname ?? conv.other?.displayName ?? 'Someone')
          : 'Someone'
        const preview =
          msg.type === 'text'
            ? msg.text ?? ''
            : msg.type === 'image'
              ? 'Sent a photo'
              : msg.type === 'video'
                ? 'Sent a video'
                : 'New message'
        toast(`${who}: ${preview}`, {
          description: 'Open Chats to reply',
          action: {
            label: 'Open',
            onClick: () => {
              useAppStore.getState().openConversation(msg.conversationId)
            },
          },
        })
      }
    }

    const onConversationNew = (data: { conversationId?: string; groupName?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      subscribeConv(data?.conversationId)
      if (data?.conversationId !== activeRef.current) {
        toast(data?.groupName ? `Added to “${data.groupName}”` : 'New conversation started', {
          description: 'Open Chats to say hello.',
        })
      }
    }

    const onPresenceUpdate = () => {
      queryClient.invalidateQueries({ queryKey: ['people'] })
      queryClient.invalidateQueries({ queryKey: ['nearby'] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      queryClient.invalidateQueries({ queryKey: ['contacts'] })
    }

    const onConversationUpdated = (data: { conversationId?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (data?.conversationId) {
        queryClient.invalidateQueries({ queryKey: ['conversation', data.conversationId] })
        queryClient.invalidateQueries({ queryKey: ['messages', data.conversationId] })
      }
    }

    const onConversationDeleted = (data: { conversationIds?: string[]; reason?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
      if (data?.conversationIds?.includes(activeRef.current ?? '')) {
        closeConversation()
        toast(
          data.reason === 'account_deleted'
            ? 'This conversation ended — the other person deleted their account.'
            : 'This conversation was closed and removed.'
        )
      }
    }

    const onRead = (data: { conversationId?: string }) => {
      if (data?.conversationId) {
        queryClient.invalidateQueries({ queryKey: ['messages', data.conversationId] })
      }
    }

    const onMessageChanged = (data: { conversationId?: string }) => {
      if (!data?.conversationId) return
      queryClient.invalidateQueries({ queryKey: ['messages', data.conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    }

    const onTyping = (data: { conversationId?: string; typing?: boolean }) => {
      if (!data?.conversationId) return
      // Typing events don't carry identity of sender publicly; treat as "them"
      setTyping(data.conversationId, data.typing ? 'them' : null)
    }

    // Buzz feed broadcasts: new/deleted posts and new/deleted comments.
    const onFeedUpdate = (data: { reason?: string; postId?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['posts'] })
      if (data?.postId) {
        queryClient.invalidateQueries({ queryKey: ['post-thread', data.postId] })
      }
    }

    const onBuzzNotification = (data: { title?: string; body?: string; postId?: string }) => {
      if (data?.postId) {
        queryClient.invalidateQueries({ queryKey: ['posts'] })
        queryClient.invalidateQueries({ queryKey: ['post-thread', data.postId] })
      }
      toast(data?.title ?? 'Buzz', {
        description: data?.body ?? 'There is new activity on a post you contributed to.',
        action: {
          label: 'Open Buzz',
          onClick: () => setTab('feed'),
        },
      })
    }

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('message:new', onMessageNew)
    socket.on('conversation:new', onConversationNew)
    socket.on('conversation:updated', onConversationUpdated)
    socket.on('conversation:deleted', onConversationDeleted)
    socket.on('presence:update', onPresenceUpdate)
    socket.on('conversation:read', onRead)
    socket.on('message:changed', onMessageChanged)
    socket.on('typing', onTyping)
    socket.on('feed:update', onFeedUpdate)
    socket.on('buzz:notification', onBuzzNotification)
    if (socket.connected) onConnect()

    // Heartbeat keeps server-side presence fresh even without traffic
    const hb = setInterval(() => {
      if (socket.connected) socket.emit('presence:heartbeat')
    }, 20_000)

    return () => {
      clearInterval(hb)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('message:new', onMessageNew)
      socket.off('conversation:new', onConversationNew)
      socket.off('conversation:updated', onConversationUpdated)
      socket.off('conversation:deleted', onConversationDeleted)
      socket.off('presence:update', onPresenceUpdate)
      socket.off('conversation:read', onRead)
      socket.off('message:changed', onMessageChanged)
      socket.off('typing', onTyping)
      socket.off('feed:update', onFeedUpdate)
      socket.off('buzz:notification', onBuzzNotification)
    }
  }, [socketToken, myPublicId, queryClient, closeConversation, setSocketConnected, setTab, setTyping])
}
