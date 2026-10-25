/**
 * Client-safe DTO types shared by the Next.js app and UI components.
 * NOTE: internal database ids (cuids) are NEVER exposed for *users* —
 * user identity always travels as `publicId`. Resource ids (conversations,
 * messages, stories, files) are opaque tokens authorized server-side.
 */

export type PresenceInfo = {
  online: boolean
  lastSeenAt: string | null
}

export type PublicProfile = {
  publicId: string
  displayName: string
  avatarUrl: string | null
} & PresenceInfo

/** A person in the online directory (People tab). */
export type OnlinePerson = PublicProfile & {
  /** Existing direct conversation with this person, if one was already started. */
  conversationId: string | null
  /** True when this person is one of my favourited contacts. */
  favorited: boolean
}

export type NearbyUser = PublicProfile & {
  distanceMeters: number
  distanceLabel: string
}

export type OwnProfile = {
  publicId: string
  displayName: string
  avatarUrl: string | null
  nearbyVisible: boolean
  showInPeople: boolean
  notifyWhenPeopleOnline: boolean
  onlineNotificationAudience: 'anyone' | 'friends'
  defaultStoryAudience: 'public' | 'friends'
  inviteCode: string
  recoveryCode: string
  createdAt: string
  locationUpdatedAt: string | null
} & PresenceInfo

export type SessionResponse = {
  authenticated: boolean
  profile: OwnProfile | null
  socketToken: string | null
}

export type ExpirationPolicyDTO = '24h' | '3months' | 'never'

export type ConversationMemberDTO = PublicProfile & {
  /** Private nickname only visible to me (from my saved contacts). */
  nickname: string | null
}

export type ConversationSummary = {
  id: string
  type: 'direct' | 'group'
  /** Group display name (groups only, null for direct chats). */
  name: string | null
  status: 'active' | 'ended'
  expirationPolicy: ExpirationPolicyDTO
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  expiresSoon: boolean
  unreadCount: number
  /** Direct chats: the other person. Null for groups. */
  other: (PublicProfile & {
    nickname: string | null
    savedAsContact: boolean
    favorited: boolean
  }) | null
  /** Group chats: every other member. Empty for direct chats. */
  members: ConversationMemberDTO[]
  /** Group creator's public id (null when the creator has left). */
  createdByPublicId: string | null
  lastMessage: {
    id: string
    senderPublicId: string
    type: 'text' | 'image' | 'video' | 'system'
    text: string | null
    createdAt: string
  } | null
}

export type MessageDTO = {
  id: string
  conversationId: string
  senderPublicId: string
  /** Sender display name — populated for group chats (rendered above bubbles). */
  senderName?: string | null
  type: 'text' | 'image' | 'video' | 'system'
  text: string | null
  mediaUrl: string | null
  createdAt: string
  clientId: string | null
  pending?: boolean
  failed?: boolean
}

export type ContactDTO = {
  publicId: string
  displayName: string
  avatarUrl: string | null
  online: boolean
  lastSeenAt: string | null
  nickname: string | null
  favorite: boolean
  savedAt: string
}

export type StoryDTO = {
  id: string
  type: 'text' | 'image' | 'video'
  text: string | null
  mediaUrl: string | null
  audience: 'public' | 'friends'
  createdAt: string
  expiresAt: string
  viewedByMe: boolean
  isOwn: boolean
}

export type StoryGroup = {
  owner: {
    publicId: string
    displayName: string
    avatarUrl: string | null
    online: boolean
    isOwn: boolean
  }
  stories: StoryDTO[]
  hasUnseen: boolean
}

export type BlockDTO = {
  publicId: string
  displayName: string
  avatarUrl: string | null
  blockedAt: string
}

// ─── Buzz feed (text-only posts) ─────────────────────────────────────────────

export type PostAuthorDTO = {
  publicId: string
  displayName: string
  avatarUrl: string | null
  online: boolean
}

export type PostDTO = {
  id: string
  text: string
  author: PostAuthorDTO
  /** up − down (cached server-side, recomputed on every vote) */
  voteScore: number
  commentCount: number
  /** my current vote: 1 = liked, -1 = disliked, 0 = none */
  myVote: -1 | 0 | 1
  isOwn: boolean
  createdAt: string
}

export type PostCommentDTO = {
  id: string
  text: string
  author: PostAuthorDTO
  isOwn: boolean
  createdAt: string
}

/** Preview of who an invite code belongs to (before connecting). */
export type InviteLookup = {
  publicId: string
  displayName: string
  avatarUrl: string | null
  online: boolean
  lastSeenAt: string | null
}

/**
 * What an invite code resolves to — user codes open a direct chat, group
 * codes (leading "G") join a group.
 */
export type InviteLookupResponse =
  | { type: 'user'; profile: InviteLookup }
  | { type: 'group'; group: { name: string; memberCount: number; isMember: boolean } }

export type PushConfig = {
  enabled: boolean
  publicKey: string | null
}

export type PushSubscriptionInput = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}
