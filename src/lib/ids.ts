import { randomBytes, randomInt } from 'crypto'

// Unambiguous alphabet (no I, L, O, U, 0, 1)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function randomCode(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

/** Public-facing user id, e.g. "GX-7K2N9Q" */
export function generatePublicId(): string {
  return `GX-${randomCode(6)}`
}

/** Invite code, e.g. "XK7Q-2M9P" */
export function generateInviteCode(): string {
  return `${randomCode(4)}-${randomCode(4)}`
}

/**
 * Group join code, e.g. "GXK7-2M9P" — always carries the leading "G" and
 * normalizes to 9 characters (user invite codes normalize to 8), so code
 * shape alone routes lookup/join to the right table.
 */
export function generateGroupJoinCode(): string {
  return `G${randomCode(4)}-${randomCode(4)}`
}

/** Recovery code, e.g. "R7K2M-9QP4X-N8V3B" */
export function generateRecoveryCode(): string {
  return `R${randomCode(4)}-${randomCode(5)}-${randomCode(5)}`
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

const CODE_RE = /^[A-Z2-9]+$/

/** Normalize user-supplied codes (invite / recovery): uppercase, strip separators & spaces */
export function normalizeCode(input: string): string {
  return (input || '').toUpperCase().replace(/[\s\-_]+/g, '')
}

export function isValidCodeShape(normalized: string, min = 6, max = 16): boolean {
  return normalized.length >= min && normalized.length <= max && CODE_RE.test(normalized)
}
