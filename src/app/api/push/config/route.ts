import { handle, ok, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getPublicKey } from '@/lib/push'

export const dynamic = 'force-dynamic'

/** Public VAPID key for clients to subscribe with. */
export const GET = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  return ok({ enabled: Boolean(getPublicKey()), publicKey: getPublicKey() })
})
