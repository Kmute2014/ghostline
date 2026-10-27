import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'
import { Timestamp } from 'firebase-admin/firestore'
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
  const firestore = getFirebaseAdminFirestore()
  const isGroup = conversation.type === 'group'
  const others = participants.filter((p) => p.userId !== meId)
  const myPart = participants.find((p) => p.userId === meId)

  const messagesSnapshot = await firestore
    .collection('conversations')
    .doc(conversation.id)
    .collection('messages')
    .orderBy('createdAt', 'desc')
    .get()

  const messageRows = messagesSnapshot.docs.map((doc) => {
    const data = doc.data()
    const rawDate = data.createdAt
    const createdAt =
      rawDate instanceof Timestamp
        ? rawDate.toDate()
        : rawDate instanceof Date
          ? rawDate
          : new Date(rawDate ?? Date.now())

    const deletedAt = data.deletedForEveryoneAt
    const deletedForEveryone = Boolean(deletedAt)

    return {
      id: doc.id,
      senderId: String(data.senderId ?? ''),
      type: String(data.type ?? 'text'),
      text: data.text == null ? null : String(data.text),
      createdAt,
      deletedForEveryone,
      hiddenForUserIds: Array.isArray(data.hiddenForUserIds)
        ? data.hiddenForUserIds.map(String)
        : [],
    }
  })

  const visibleMessages = messageRows.filter(
    (message) => !message.hiddenForUserIds.includes(meId)
  )

  const lastMessage = visibleMessages[0] ?? null

  const otherIds = new Set(others.map((participant) => participant.userId))
  const lastReadAt = myPart?.lastReadAt ?? null

  const unreadCount = messageRows.filter((message) => {
    if (message.deletedForEveryone) return false
    if (message.hiddenForUserIds.includes(meId)) return false
    if (!otherIds.has(message.senderId)) return false
    if (lastReadAt && message.createdAt <= lastReadAt) return false
    return true
  }).length

  const senderPart = lastMessage
    ? participants.find((p) => p.userId === lastMessage.senderId)
    : undefined

  const lastMessageDTO = lastMessage
    ? {
        id: lastMessage.id,
        senderPublicId: senderPart?.user.publicId ?? '',
        type: lastMessage.type as 'text' | 'image' | 'video' | 'system',
        text: lastMessage.deletedForEveryone ? null : lastMessage.text,
        createdAt: lastMessage.createdAt.toISOString(),
        deletedForEveryone: lastMessage.deletedForEveryone,
      }
    : null

  const creatorPart = participants.find(
    (p) => p.userId === conversation.createdById
  )

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
      expiresSoon: false,
      unreadCount,
      other: null,
      members: others.map((participant) => ({
        ...toPublicProfile(
          participant.user,
          presenceByUser.get(participant.userId) ?? null
        ),
        nickname: contacts.get(participant.userId)?.nickname ?? null,
      })),
      createdByPublicId: creatorPart?.user.publicId ?? null,
      lastMessage: lastMessageDTO,
    }
  }

  const other = others[0]

  if (!other) {
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
    expiresSoon: isExpiringSoon(
      conversation.expiresAt,
      conversation.expirationPolicy
    ),
    unreadCount,
    other: {
      ...toPublicProfile(
        other.user,
        presenceByUser.get(other.userId) ?? null
      ),
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
    editedAt?: Date | null
    deletedForEveryoneAt?: Date | null
  },
  senderPublicId: string,
  senderName: string | null = null,
  replyTo?: {
    id: string
    sender: { publicId: string; displayName: string }
    type: string
    text: string | null
    deletedForEveryoneAt: Date | null
    hiddenFor: { userId: string }[]
  } | null
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
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedForEveryone: Boolean(m.deletedForEveryoneAt),
    replyTo:
      replyTo && replyTo.hiddenFor.length === 0
        ? {
            id: replyTo.id,
            senderPublicId: replyTo.sender.publicId,
            senderName: replyTo.sender.displayName,
            type: replyTo.type as 'text' | 'image' | 'video' | 'system',
            text: replyTo.text,
            deletedForEveryone: Boolean(replyTo.deletedForEveryoneAt),
          }
        : null,
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
