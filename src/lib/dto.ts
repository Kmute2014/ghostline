import { db } from '@/lib/db'
import { approximateDistance } from '@/lib/geo'
import { isExpiringSoon } from '@/lib/expire'
import type {
  PublicProfile,
  OwnProfile,
  ConversationSummary,
  MessageDTO,
  ExpirationPolicyDTO,
  StoryDTO,
} from '@/lib/types'

type ProfileRow = {
  publicId: string
  displayName: string
  avatarFileId: string | null
}

type PresenceRow = {
  isOnline: boolean
  lastSeenAt: Date
} | null

export function avatarUrlFor(fileId: string | null): string | null {
  return fileId ? `/api/files/${fileId}` : null
}

export function toPublicProfile(
  profile: ProfileRow,
  presence: PresenceRow,
  overrides?: { online?: boolean }
): PublicProfile {
  return {
    publicId: profile.publicId,
    displayName: profile.displayName,
    avatarUrl: avatarUrlFor(profile.avatarFileId),
    online: overrides?.online ?? (presence?.isOnline ?? false),
    lastSeenAt: presence?.isOnline ? null : presence?.lastSeenAt?.toISOString() ?? null,
  }
}

export function toOwnProfile(
  profile: {
    publicId: string
    displayName: string
    avatarFileId: string | null
    nearbyVisible: boolean
    showInPeople: boolean
    notifyWhenPeopleOnline: boolean
    onlineNotificationAudience: string
    defaultStoryAudience: string
    inviteCode: string
    recoveryCode: string
    createdAt: Date
  },
  presence: PresenceRow,
  location: { updatedAt: Date } | null
): OwnProfile {
  return {
    publicId: profile.publicId,
    displayName: profile.displayName,
    avatarUrl: avatarUrlFor(profile.avatarFileId),
    nearbyVisible: profile.nearbyVisible,
    showInPeople: profile.showInPeople,
    notifyWhenPeopleOnline: profile.notifyWhenPeopleOnline,
    onlineNotificationAudience:
      profile.onlineNotificationAudience === 'friends' ? 'friends' : 'anyone',
    defaultStoryAudience: profile.defaultStoryAudience === 'friends' ? 'friends' : 'public',
    inviteCode: profile.inviteCode,
    recoveryCode: profile.recoveryCode,
    createdAt: profile.createdAt.toISOString(),
    locationUpdatedAt: location?.updatedAt.toISOString() ?? null,
    online: presence?.isOnline ?? false,
    lastSeenAt: presence?.isOnline ? null : presence?.lastSeenAt?.toISOString() ?? null,
  }
}

type ConversationRow = {
  id: string
  type: string
  name: string | null
  status: string
  expirationPolicy: string
  expiresAt: Date | null
  createdById: string
  createdAt: Date
  updatedAt: Date
}

type ParticipantRow = {
  userId: string
  lastReadAt: Date | null
  user: ProfileRow
}

type PresenceByUser = Map<string, PresenceRow>

type ContactFlags = Map<string, { nickname: string | null; favorite: boolean }>

export type { ContactFlags }

/**
 * Builds the client summary for a conversation (direct or group) from a fully
 * loaded conversation row (participants included). Presence is passed in a
 * side map because call sites load it differently.
 */
export async function toConversationSummary(
  conversation: ConversationRow,
  meId: string,
  participants: ParticipantRow[],
  presenceByUser: PresenceByUser,
  contacts: ContactFlags
): Promise<ConversationSummary> {
  const isGroup = conversation.type === 'group'
  const others = participants.filter((p) => p.userId !== meId)
  const myPart = participants.find((p) => p.userId === meId)

  const [lastMessage, unreadCount] = await Promise.all([
    db.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, senderId: true, type: true, text: true, createdAt: true },
    }),
    db.message.count({
      where: {
        conversationId: conversation.id,
        senderId: { in: others.map((o) => o.userId) },
        createdAt: myPart?.lastReadAt ? { gt: myPart.lastReadAt } : undefined,
      },
    }),
  ])

  // Senders are always participants, so the public id can be resolved locally.
  const senderPart = lastMessage
    ? participants.find((p) => p.userId === lastMessage.senderId)
    : undefined

  const lastMessageDTO = lastMessage
    ? {
        id: lastMessage.id,
        senderPublicId: senderPart ? senderPart.user.publicId : '',
        type: lastMessage.type as 'text' | 'image' | 'video' | 'system',
        text: lastMessage.text,
        createdAt: lastMessage.createdAt.toISOString(),
      }
    : null

  const creatorPart = participants.find((p) => p.userId === conversation.createdById)

  if (isGroup) {
    return {
      id: conversation.id,
      type: 'group',
      name: conversation.name,
      status: conversation.status === 'ended' ? 'ended' : 'active',
      expirationPolicy: conversation.expirationPolicy as ExpirationPolicyDTO,
      expiresAt: conversation.expiresAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      expiresSoon: false, // groups never expire
      unreadCount,
      other: null,
      members: others.map((o) => ({
        ...toPublicProfile(o.user, presenceByUser.get(o.userId) ?? null),
        nickname: contacts.get(o.userId)?.nickname ?? null,
      })),
      createdByPublicId: creatorPart?.user.publicId ?? null,
      lastMessage: lastMessageDTO,
    }
  }

  const other = others[0]
  if (!other) {
    // A direct conversation always has exactly two participants; this can only
    // happen transiently during deletion races. Report an ended shell.
    return {
      id: conversation.id,
      type: 'direct',
      name: null,
      status: 'ended',
      expirationPolicy: conversation.expirationPolicy as ExpirationPolicyDTO,
      expiresAt: conversation.expiresAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      expiresSoon: false,
      unreadCount: 0,
      other: null,
      members: [],
      createdByPublicId: null,
      lastMessage: lastMessageDTO,
    }
  }

  const contactFlags = contacts.get(other.userId)
  return {
    id: conversation.id,
    type: 'direct',
    name: null,
    status: conversation.status === 'ended' ? 'ended' : 'active',
    expirationPolicy: conversation.expirationPolicy as ExpirationPolicyDTO,
    expiresAt: conversation.expiresAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    expiresSoon: isExpiringSoon(conversation.expiresAt, conversation.expirationPolicy),
    unreadCount,
    other: {
      ...toPublicProfile(other.user, presenceByUser.get(other.userId) ?? null),
      nickname: contactFlags?.nickname ?? null,
      savedAsContact: contacts.has(other.userId),
      favorited: contactFlags?.favorite ?? false,
    },
    members: [],
    createdByPublicId: creatorPart?.user.publicId ?? null,
    lastMessage: lastMessageDTO,
  }
}

export function toMessageDTO(
  m: {
    id: string
    conversationId: string
    senderId: string
    type: string
    text: string | null
    fileId: string | null
    clientId: string | null
    createdAt: Date
  },
  senderPublicId: string,
  senderName: string | null = null
): MessageDTO {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderPublicId,
    senderName,
    type: m.type as 'text' | 'image' | 'video' | 'system',
    text: m.text,
    mediaUrl: m.fileId ? `/api/files/${m.fileId}` : null,
    createdAt: m.createdAt.toISOString(),
    clientId: m.clientId,
  }
}

export function toStoryDTO(
  s: {
    id: string
    ownerId: string
    type: string
    text: string | null
    fileId: string | null
    audience: string
    createdAt: Date
    expiresAt: Date
  },
  ownerPublicId: string,
  opts: { isOwn: boolean; viewedByMe: boolean }
): StoryDTO {
  return {
    id: s.id,
    type: s.type as 'text' | 'image' | 'video',
    text: s.text,
    mediaUrl: s.fileId ? `/api/files/${s.fileId}` : null,
    audience: s.audience === 'friends' ? 'friends' : 'public',
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    viewedByMe: opts.viewedByMe,
    isOwn: opts.isOwn,
  }
}

export { approximateDistance }
