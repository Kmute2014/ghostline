// Throwaway E2E probe: user B goes online, listens, replies to A.
import { io } from 'socket.io-client'

const [, , socketTokenB, convPayload] = process.argv
if (!socketTokenB) { console.error('usage: node rt-test.mjs <socketTokenB> [convJson]'); process.exit(1) }

const socket = io('http://localhost:3003', { auth: { token: socketTokenB }, transports: ['websocket'] })

socket.on('connect', () => {
  console.log('B connected', socket.id)
  setInterval(() => socket.emit('presence:heartbeat'), 10_000)
  if (convPayload) {
    const conv = JSON.parse(convPayload)
    // subscribe + reply after a moment (simulates B seeing the chat and answering)
    socket.emit('conversation:subscribe', { conversationId: conv.conversationId })
    setTimeout(() => {
      socket.emit('message:send', { conversationId: conv.conversationId, text: 'Hey A! B here 👋', clientId: 'b-1' }, (r) => {
        console.log('B send ack:', JSON.stringify(r))
      })
      setTimeout(() => { console.log('B done'); process.exit(0) }, 1500)
    }, 1200)
  } else {
    console.log('B staying online 12s')
  }
})

socket.on('conversation:new', (d) => console.log('B event conversation:new', JSON.stringify(d)))
socket.on('message:new', (d) => console.log('B event message:new', JSON.stringify(d)))
socket.on('presence:update', (d) => console.log('B event presence:update', JSON.stringify(d)))
socket.on('connect_error', (e) => { console.error('B connect_error', e.message); process.exit(1) })

if (!convPayload) setTimeout(() => { console.log('B leaving'); process.exit(0) }, 150_000)
