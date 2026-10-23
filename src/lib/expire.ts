import { addHours, addMonths } from 'date-fns'

export const EXPIRATION_POLICIES = ['24h', '3months', 'never'] as const
export type ExpirationPolicy = (typeof EXPIRATION_POLICIES)[number]

export const POLICY_LABELS: Record<ExpirationPolicy, string> = {
  '24h': '24 hours',
  '3months': '3 months',
  never: 'Never',
}

export function isExpirationPolicy(v: unknown): v is ExpirationPolicy {
  return typeof v === 'string' && (EXPIRATION_POLICIES as readonly string[]).includes(v)
}

/** Expiration is always computed from a server-side timestamp. */
export function computeExpiresAt(policy: ExpirationPolicy, from: Date = new Date()): Date | null {
  switch (policy) {
    case '24h':
      return addHours(from, 24)
    case '3months':
      return addMonths(from, 3)
    case 'never':
      return null
  }
}

export function isConversationExpired(c: { expiresAt: Date | null; status: string }): boolean {
  if (c.status !== 'active') return true
  if (c.expiresAt && c.expiresAt.getTime() <= Date.now()) return true
  return false
}

/** Warning threshold: 24h chats warn under 6h left, 3-month chats under 7 days. */
export function isExpiringSoon(expiresAt: Date | null, policy: string): boolean {
  if (!expiresAt) return false
  const remaining = expiresAt.getTime() - Date.now()
  if (policy === '24h') return remaining < 6 * 3_600_000
  if (policy === '3months') return remaining < 7 * 24 * 3_600_000
  return false
}

export const STORY_TTL_HOURS = 24
