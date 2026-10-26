export const POST_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export function getPostRetentionCutoff(now = Date.now()): Date {
  return new Date(now - POST_RETENTION_MS)
}
