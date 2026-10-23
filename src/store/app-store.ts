"use client";

import { create } from 'zustand'
import type { OwnProfile } from '@/lib/types'

export type Tab = 'nearby' | 'people' | 'feed' | 'stories' | 'chats' | 'profile'

type TypingState = Record<string, { publicId: string; at: number }>

type AppState = {
  /** null = still bootstrapping; undefined = checked and no identity */
  profile: OwnProfile | null
  profileChecked: boolean
  setProfile: (p: OwnProfile | null) => void

  socketConnected: boolean
  setSocketConnected: (v: boolean) => void

  tab: Tab
  setTab: (t: Tab) => void

  /** When set, the chat view is open (stacked above the current tab) */
  activeConversationId: string | null
  openConversation: (id: string) => void
  closeConversation: () => void

  /** id of the pending invite code from ?invite= query param */
  pendingInviteCode: string | null
  setPendingInviteCode: (code: string | null) => void

  /** Add-to-Home-Screen popup: driven by auto-triggers + the Profile "Install app" row */
  installPromptOpen: boolean
  setInstallPromptOpen: (open: boolean) => void

  /** live typing indicators: conversationId → who/when */
  typing: TypingState
  setTyping: (conversationId: string, publicId: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  profile: null,
  profileChecked: false,
  setProfile: (profile) => set({ profile, profileChecked: true }),

  socketConnected: false,
  setSocketConnected: (socketConnected) => set({ socketConnected }),

  tab: 'people',
  // Switching tabs from the nav always pops an open chat view (iOS-style:
  // tapping a tab while pushed into a conversation returns to that tab).
  setTab: (tab) => {
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem('gl-active-conv')
      } catch {
        /* private mode */
      }
    }
    set({ tab, activeConversationId: null })
  },

  activeConversationId: null,
  openConversation: (activeConversationId) => {
    // Remember the open chat so a refresh restores the conversation view
    // (history itself is server-side and survives refreshes regardless).
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem('gl-active-conv', activeConversationId)
      } catch {
        /* private mode */
      }
    }
    set({ activeConversationId })
  },
  closeConversation: () => {
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem('gl-active-conv')
      } catch {
        /* private mode */
      }
    }
    set({ activeConversationId: null })
  },

  pendingInviteCode: null,
  setPendingInviteCode: (pendingInviteCode) => set({ pendingInviteCode }),

  installPromptOpen: false,
  setInstallPromptOpen: (installPromptOpen) => set({ installPromptOpen }),

  typing: {},
  setTyping: (conversationId, publicId) =>
    set((state) => {
      const typing = { ...state.typing }
      if (publicId) typing[conversationId] = { publicId, at: Date.now() }
      else delete typing[conversationId]
      return { typing }
    }),
}))
