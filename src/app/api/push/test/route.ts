import { handle, ok, unauthorized, badRequest, tooMany } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { isPushConfigured, sendPushToUser } from '@/lib/push'
import { rateLimit } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export const POST = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()
  if (!rateLimit(`push-test:${auth.profile.id}`, 5, 60_000)) {
    throw tooMany('Please wait before sending another test notification.', 60)
  }
  if (!isPushConfigured()) {
    throw badRequest('Push notifications are not available on this server.', 'PUSH_DISABLED')
  }

  const delivered = await sendPushToUser(auth.profile.id, {
    title: 'Ghostline',
    body: 'Push notifications are working on this device.',
    tag: 'push-test',
  })

  return ok({ delivered })
})
