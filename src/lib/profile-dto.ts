
import type { OwnProfile, PublicProfile } from '@/lib/types'

type PresenceRow = {
  isOnline: boolean
  lastSeenAt: Date | null
} | null

export function avatarUrlFor(fileId: string | null): string | null {
  return fileId ? `/api/files/${fileId}` : null
}

export function toPublicProfile(
  profile: {
    publicId: string
    displayName: string
    avatarFileId: string | null
  },
  presence: PresenceRow,
  overrides?: { online?: boolean },
): PublicProfile {
  return {
    publicId: profile.publicId,
    displayName: profile.displayName,
    avatarUrl: avatarUrlFor(profile.avatarFileId),
    online: overrides?.online ?? (presence?.isOnline ?? false),
    lastSeenAt: presence?.isOnline
      ? null
      : presence?.lastSeenAt?.toISOString() ?? null,
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
  location: { updatedAt: Date } | null,
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
    defaultStoryAudience:
      profile.defaultStoryAudience === 'friends' ? 'friends' : 'public',
    inviteCode: profile.inviteCode,
    recoveryCode: profile.recoveryCode,
    createdAt: profile.createdAt.toISOString(),
    locationUpdatedAt: location?.updatedAt.toISOString() ?? null,
    online: presence?.isOnline ?? false,
    lastSeenAt: presence?.isOnline
      ? null
      : presence?.lastSeenAt?.toISOString() ?? null,
  }
}
