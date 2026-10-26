"use client";

import type {
  SessionResponse,
  OwnProfile,
  NearbyUser,
  OnlinePerson,
  ConversationSummary,
  MessageDTO,
  ContactDTO,
  StoryGroup,
  StoryDTO,
  BlockDTO,
  ExpirationPolicyDTO,
  InviteLookup,
  InviteLookupResponse,
  PushConfig,
  PushSubscriptionInput,
  PostDTO,
  PostCommentDTO,
} from '@/lib/types'

/**
 * Thin typed client for the Ghostline API. All requests are same-origin and
 * cookie-authenticated (httpOnly session). Errors are normalized to
 * { code, message } so UI can show actionable messages.
 */

export class ApiClientError extends Error {
  code: string
  status: number
  retryAfterSec?: number
  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfterSec = retryAfterSec
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiClientError(0, 'NETWORK', 'You appear to be offline. Check your connection.')
  }
  if (!res.ok) {
    let code = 'ERROR'
    let message = `Request failed (${res.status})`
    let retryAfterSec: number | undefined
    try {
      const data = await res.json()
      if (data?.error) {
        code = data.error.code ?? code
        message = data.error.message ?? message
        retryAfterSec = data.error.retryAfterSec
      }
    } catch {
      /* non-JSON error */
    }
    throw new ApiClientError(res.status, code, message, retryAfterSec)
  }
  return res.json() as Promise<T>
}

const json = (body: unknown) => JSON.stringify(body)

// ─── session / identity ──────────────────────────────────────────────────────

export const api = {
  getSession: () => request<SessionResponse>('/api/session'),

  getMe: () => request<OwnProfile>('/api/me'),

  createIdentity: (displayName: string) =>
    request<SessionResponse & { isNewUser?: boolean }>('/api/session', {
      method: 'POST',
      body: json({ displayName }),
    }),

  recoverIdentity: (recoveryCode: string) =>
    request<SessionResponse>('/api/session', {
      method: 'PUT',
      body: json({ recoveryCode }),
    }),

  updateMe: (
    patch: Partial<
      Pick<
        OwnProfile,
        | 'displayName'
        | 'nearbyVisible'
        | 'showInPeople'
        | 'notifyWhenPeopleOnline'
        | 'onlineNotificationAudience'
        | 'defaultStoryAudience'
      > & {
        avatarFileId: string | null
      }
    >
  ) => request<OwnProfile>('/api/me', { method: 'PATCH', body: json(patch) }),

  deleteAccount: () =>
    request<{ deleted: boolean }>('/api/auth/delete', {
      method: 'POST',
      body: json({ confirm: 'DELETE' }),
    }),

  // ─── location / nearby ─────────────────────────────────────────────────────

  updateLocation: (lat: number, lng: number, accuracy?: number | null) =>
    request<{ locationUpdatedAt: string; shared: boolean }>('/api/location', {
      method: 'POST',
      body: json({ lat, lng, accuracy }),
    }),

  disableLocation: () =>
    request<{ shared: boolean; nearbyVisible: boolean }>('/api/location', { method: 'DELETE' }),

  getNearby: (radiusMeters: number) =>
    request<{ users: NearbyUser[]; requiresLocation: boolean; stale?: boolean }>(
      `/api/nearby?radius=${encodeURIComponent(radiusMeters)}`
    ),

  // ─── people (online directory) ─────────────────────────────────────────────

  getPeople: () => request<{ users: OnlinePerson[]; count: number }>('/api/people'),

  // ─── conversations / messages ──────────────────────────────────────────────

  createConversation: (publicId: string, expirationPolicy: ExpirationPolicyDTO = '24h') =>
    request<{ conversation: ConversationSummary }>('/api/conversations', {
      method: 'POST',
      body: json({ publicId, expirationPolicy }),
    }),

  createGroup: (name: string, memberPublicIds: string[]) =>
    request<{ conversation: ConversationSummary; skipped: string[] }>('/api/groups', {
      method: 'POST',
      body: json({ name, memberPublicIds }),
    }),

  /** Invites users into an existing group (any member can). */
  addGroupMembers: (id: string, memberPublicIds: string[]) =>
    request<{ added: string[]; skipped: string[]; memberCount: number }>(
      `/api/conversations/${id}/members`,
      { method: 'POST', body: json({ memberPublicIds }) }
    ),

  /** The group's shareable join code; `{ rotate: true }` invalidates the old one. */
  getGroupInvite: (id: string, rotate = false) =>
    request<{ joinCode: string; shareUrl: string; rotated: boolean }>(
      `/api/conversations/${id}/invite`,
      { method: 'POST', body: json({ rotate }) }
    ),

  /** Joins a group through its shareable invite code (idempotent for members). */
  joinGroup: (code: string) =>
    request<{ conversation: ConversationSummary; joined: boolean }>('/api/groups/join', {
      method: 'POST',
      body: json({ code }),
    }),

  leaveGroup: (id: string) =>
    request<{ left: boolean; deleted: boolean }>(`/api/conversations/${id}/leave`, {
      method: 'POST',
      body: json({}),
    }),

  getConversations: () =>
    request<{ conversations: ConversationSummary[] }>('/api/conversations'),

  getConversation: (id: string) =>
    request<{ conversation: ConversationSummary; iBlockedThem: boolean; theyBlockedMe: boolean }>(
      `/api/conversations/${id}`
    ),

  getMessages: (id: string, before?: string | null) =>
    request<{ messages: MessageDTO[]; hasMore: boolean; oldestCursor: string | null; otherLastReadAt: string | null }>(
      `/api/conversations/${id}/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`
    ),

  sendMessage: (id: string, payload: { type: string; text?: string; fileId?: string | null; clientId?: string; replyToId?: string }) =>
    request<{ message: MessageDTO }>(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: json(payload),
    }),

  editMessage: (conversationId: string, messageId: string, text: string) =>
    request<{ messageId: string; text: string; editedAt: string | null }>(
      `/api/conversations/${conversationId}/messages/${messageId}`,
      { method: 'PATCH', body: json({ text }) }
    ),

  deleteMessage: (conversationId: string, messageId: string, mode: 'me' | 'everyone') =>
    request<{ deleted: boolean }>(`/api/conversations/${conversationId}/messages/${messageId}`, {
      method: 'DELETE',
      body: json({ mode }),
    }),

  markRead: (id: string) =>
    request<{ lastReadAt: string }>(`/api/conversations/${id}/read`, { method: 'POST', body: json({}) }),

  updateConversation: (id: string, patch: { expirationPolicy?: ExpirationPolicyDTO; end?: boolean }) =>
    request<{ conversation: ConversationSummary }>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: json(patch),
    }),

  deleteConversation: (id: string) =>
    request<{ deleted: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),

  // ─── contacts ──────────────────────────────────────────────────────────────

  getContacts: () => request<{ contacts: ContactDTO[] }>('/api/contacts'),
  saveContact: (publicId: string, nickname?: string) =>
    request<{ publicId: string; nickname: string | null; saved: boolean }>('/api/contacts', {
      method: 'POST',
      body: json({ publicId, nickname }),
    }),
  renameContact: (publicId: string, nickname: string) =>
    request<{ publicId: string; nickname: string; favorite: boolean }>(`/api/contacts/${publicId}`, {
      method: 'PATCH',
      body: json({ nickname }),
    }),
  setContactFavorite: (publicId: string, favorite: boolean) =>
    request<{ publicId: string; nickname: string | null; favorite: boolean; saved: boolean }>(
      `/api/contacts/${publicId}`,
      { method: 'PATCH', body: json({ favorite }) }
    ),
  removeContact: (publicId: string) =>
    request<{ removed: boolean }>(`/api/contacts/${publicId}`, { method: 'DELETE' }),

  // ─── invites ───────────────────────────────────────────────────────────────

  getInvite: () =>
    request<{ inviteCode: string; shareUrl: string; createdAt: string }>('/api/invites'),
  rotateInvite: () => request<{ inviteCode: string }>('/api/invites', { method: 'POST' }),
  redeemInvite: (code: string, expirationPolicy: ExpirationPolicyDTO) =>
    request<{ conversation: ConversationSummary }>('/api/invites/redeem', {
      method: 'POST',
      body: json({ code, expirationPolicy }),
    }),
  lookupInvite: (code: string) =>
    request<InviteLookupResponse>(
      `/api/invites/lookup?code=${encodeURIComponent(code)}`
    ),

  // ─── web push (offline notifications) ────────────────────────────────────

  getPushConfig: () => request<PushConfig>('/api/push/config'),
  subscribePush: (subscription: PushSubscriptionInput) =>
    request<{ subscribed: boolean; id: string }>('/api/push/subscribe', {
      method: 'POST',
      body: json(subscription),
    }),
  unsubscribePush: (endpoint?: string) =>
    request<{ unsubscribed: boolean }>('/api/push/subscribe', {
      method: 'DELETE',
      body: json(endpoint ? { endpoint } : {}),
    }),
  sendTestPush: () =>
    request<{ delivered: number }>('/api/push/test', { method: 'POST', body: json({}) }),

  // ─── stories ───────────────────────────────────────────────────────────────

  getStories: () => request<{ groups: StoryGroup[] }>('/api/stories'),
  createStory: (payload: { type: 'text' | 'image' | 'video'; text?: string; fileId?: string | null; audience: 'public' | 'friends' }) =>
    request<{ story: StoryDTO }>('/api/stories', { method: 'POST', body: json(payload) }),
  deleteStory: (id: string) => request<{ deleted: boolean }>(`/api/stories/${id}`, { method: 'DELETE' }),
  viewStory: (id: string) => request<{ viewCount: number }>(`/api/stories/${id}/view`, { method: 'POST', body: json({}) }),
  getStoryViewers: (id: string) =>
    request<{
      viewers: { publicId: string; displayName: string; avatarUrl: string | null; online: boolean; viewedAt: string }[]
    }>(`/api/stories/${id}/viewers`),

  // ─── buzz feed (text-only posts) ────────────────────────────────────────────

  getPosts: (sort: 'hot' | 'new' = 'hot') =>
    request<{ posts: PostDTO[]; sort: string }>(`/api/posts?sort=${encodeURIComponent(sort)}`),

  createPost: (text: string, isAnonymous = false) =>
    request<{ post: PostDTO }>('/api/posts', { method: 'POST', body: json({ text, isAnonymous }) }),

  deletePost: (id: string) => request<{ deleted: boolean }>(`/api/posts/${id}`, { method: 'DELETE' }),

  /** value: 1 = like, -1 = dislike, 0 = clear my vote */
  votePost: (id: string, value: -1 | 0 | 1) =>
    request<{ voteScore: number; myVote: -1 | 0 | 1 }>(`/api/posts/${id}/vote`, {
      method: 'POST',
      body: json({ value }),
    }),

  getPostThread: (id: string) =>
    request<{ post: PostDTO; comments: PostCommentDTO[] }>(`/api/posts/${id}/comments`),

  commentPost: (id: string, text: string, isAnonymous = false) =>
    request<{ comment: PostCommentDTO; commentCount: number }>(`/api/posts/${id}/comments`, {
      method: 'POST',
      body: json({ text, isAnonymous }),
    }),

  deleteComment: (postId: string, commentId: string) =>
    request<{ deleted: boolean; commentCount: number }>(
      `/api/posts/${postId}/comments/${commentId}`,
      { method: 'DELETE' }
    ),

  // ─── safety ────────────────────────────────────────────────────────────────

  getBlocks: () => request<{ blocks: BlockDTO[] }>('/api/blocks'),
  blockUser: (publicId: string) =>
    request<{ blocked: boolean }>('/api/blocks', { method: 'POST', body: json({ publicId }) }),
  unblockUser: (publicId: string) =>
    request<{ blocked: boolean }>(`/api/blocks/${publicId}`, { method: 'DELETE' }),

  report: (payload: { publicId?: string; postId?: string; conversationId?: string; reason: string; details?: string }) =>
    request<{ reportId: string; message: string }>('/api/reports', { method: 'POST', body: json(payload) }),

  // ─── uploads ───────────────────────────────────────────────────────────────

  upload: async (file: File, kind: 'image' | 'video' | 'avatar') => {
    const form = new FormData()
    form.append('file', file)
    form.append('kind', kind)
    return request<{ id: string; kind: string; mime: string; size: number; url: string }>('/api/upload', {
      method: 'POST',
      body: form,
    })
  },
}
