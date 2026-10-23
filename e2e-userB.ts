/**
 * Simulated second anonymous user (User B) for end-to-end testing.
 * Creates an identity via the gateway, connects a live socket (presence),
 * and performs scripted actions.
 *
 * Usage: bun /home/z/test/userB.ts [command] [args]
 *   serve          — create identity, go available, hold socket, greet on match
 *   setup-nearby   — create identity with nearby visibility + location near Aurora
 *   redeem <code>  — create identity, redeem invite code
 *   story <aud>    — create identity, post a text story (public|friends)
 */
import { io } from 'socket.io-client'

const BASE = 'http://localhost:81'
const SOCKET_URL = 'http://localhost:3003' // server-side script may hit the port directly

let cookie = ''
let socketToken = ''
let publicId = ''

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const c of setCookie) {
    const [pair] = c.split(';')
    if (pair.startsWith('ghostline_session=')) cookie = pair
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`)
  return data
}

async function setup(name = 'Basil') {
  const created = (await api('/api/session', {
    method: 'POST',
    body: JSON.stringify({ displayName: name }),
  })) as { socketToken: string; profile: { publicId: string; displayName: string } }
  socketToken = created.socketToken
  publicId = created.profile.publicId
  console.log(`[B] created identity ${created.profile.displayName} (${publicId})`)
}

async function main() {
  const cmd = process.argv[2] ?? 'serve'

  if (cmd === 'setup-nearby') {
    await setup('Basil')
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ nearbyVisible: true }) })
    // ~150 m away from Aurora's position (64.1466, -21.9426)
    await api('/api/location', {
      method: 'POST',
      body: JSON.stringify({ lat: 64.1466 + 0.00135, lng: -21.9426, accuracy: 12 }),
    })
    console.log('[B] nearby visibility on, location ~150m from Aurora')
    return
  }

  if (cmd === 'serve') {
    await setup('Basil')
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ randomChatAvailable: true }) })
    const socket = io(SOCKET_URL, {
      auth: { token: socketToken },
      transports: ['websocket'], // Bun lacks reliable XHR for polling fallback
      reconnection: true,
    })
    socket.on('connect', () => {
      console.log('[B] socket connected')
      socket.emit('presence:heartbeat')
    })
    socket.on('match:found', (d: { conversationId: string }) => {
      console.log(`[B] MATCH FOUND -> ${d.conversationId}`)
      socket.emit('conversation:subscribe', { conversationId: d.conversationId })
      setTimeout(() => {
        socket.emit(
          'message:send',
          {
            conversationId: d.conversationId,
            clientId: `b-${Date.now()}`,
            type: 'text',
            text: 'Hey Aurora! Basil here - nice to match.',
          },
          (ack: { ok?: boolean }) => console.log(`[B] greeting ack ok=${ack?.ok}`)
        )
      }, 800)
    })
    socket.on('message:new', (m: { senderPublicId: string; text?: string; type: string }) => {
      if (m.senderPublicId !== publicId) console.log(`[B] received ${m.type}: "${m.text}" from ${m.senderPublicId}`)
    })
    socket.on('conversation:new', (d: { conversationId: string }) =>
      console.log(`[B] new conversation ${d.conversationId}`)
    )
    setInterval(() => socket.connected && socket.emit('presence:heartbeat'), 10_000)
    console.log('[B] serving…')
    return
  }

  if (cmd === 'redeem') {
    const code = process.argv[3]
    await setup('Basil')
    const res = (await api('/api/invites/redeem', {
      method: 'POST',
      body: JSON.stringify({ code, expirationPolicy: '24h' }),
    })) as { conversation: { id: string; expirationPolicy: string } }
    console.log(`[B] redeemed ${code} -> conversation ${res.conversation.id} (${res.conversation.expirationPolicy})`)
    return
  }

  if (cmd === 'story') {
    const audience = process.argv[3] ?? 'public'
    await setup('Basil')
    const res = (await api('/api/stories', {
      method: 'POST',
      body: JSON.stringify({ type: 'text', text: 'A public whisper from Basil', audience }),
    })) as { story: { id: string } }
    console.log(`[B] story created ${res.story.id} audience=${audience}`)
    return
  }
}

main().catch((e) => {
  console.error('[B] failed:', e.message)
  process.exit(1)
})
