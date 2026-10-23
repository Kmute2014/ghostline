/**
 * In-memory sliding-window rate limiter (per process).
 * Suitable for the single-node sandbox deployment; swap for a shared store
 * (e.g. PostgreSQL-backed) when running multiple instances.
 */

type Bucket = number[]

const globalForLimiter = globalThis as unknown as {
  __ghostlineRateBuckets: Map<string, Bucket> | undefined
}

const buckets: Map<string, Bucket> =
  globalForLimiter.__ghostlineRateBuckets ?? new Map()
globalForLimiter.__ghostlineRateBuckets = buckets

function prune(now: number) {
  if (buckets.size < 4096) return
  for (const [key, arr] of buckets) {
    const alive = arr.filter((t) => now - t < 3_600_000)
    if (alive.length === 0) buckets.delete(key)
    else buckets.set(key, alive)
  }
}

/**
 * Returns true when the action is allowed. Records the attempt otherwise
 * (attempts are only recorded for allowed calls — callers decide whether to
 * record rejected attempts by calling `record` themselves if needed).
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  prune(now)
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (arr.length >= limit) {
    buckets.set(key, arr)
    return false
  }
  arr.push(now)
  buckets.set(key, arr)
  return true
}

/** Named policy presets */
export const LIMITS = {
  messageSend: { limit: 40, windowMs: 60_000 },
  upload: { limit: 12, windowMs: 60_000 },
  matchStart: { limit: 10, windowMs: 60_000 },
  inviteRedeem: { limit: 10, windowMs: 3_600_000 },
  inviteRotate: { limit: 5, windowMs: 3_600_000 },
  storyCreate: { limit: 12, windowMs: 3_600_000 },
  report: { limit: 8, windowMs: 3_600_000 },
  contactAdd: { limit: 20, windowMs: 3_600_000 },
  conversationCreate: { limit: 12, windowMs: 3_600_000 },
  accountDelete: { limit: 3, windowMs: 3_600_000 },
  recover: { limit: 10, windowMs: 3_600_000 },
  general: { limit: 60, windowMs: 60_000 },
  inviteLookup: { limit: 30, windowMs: 60_000 },
  memberAdd: { limit: 30, windowMs: 3_600_000 },
  postCreate: { limit: 10, windowMs: 3_600_000 },
  postComment: { limit: 40, windowMs: 3_600_000 },
  postVote: { limit: 120, windowMs: 3_600_000 },
} as const
