$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path (Join-Path $root 'src\components\app-root.tsx')) -or
    -not (Test-Path (Join-Path $root 'src\hooks\use-firebase-realtime.ts')) -or
    -not (Test-Path (Join-Path $root 'mini-services\realtime\service.ts'))) {
  throw 'Run this script from the Hushly project root (D:\hush).'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $root ".firebase-presence-fix-backups\$stamp"
New-Item -ItemType Directory -Path $backup -Force | Out-Null

$filesToPatch = @(
  'src\components\app-root.tsx',
  'src\hooks\use-firebase-realtime.ts',
  'mini-services\realtime\service.ts'
)
foreach ($relative in $filesToPatch) {
  $sourcePath = Join-Path $root $relative
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backup ($relative -replace '[\\/:]', '_'))
}

function Replace-Once([string]$content, [string]$old, [string]$new, [string]$description) {
  $count = ([regex]::Matches($content, [regex]::Escape($old))).Count
  if ($count -ne 1) { throw "Expected exactly one occurrence for '$description'; found $count. No more edits will be attempted." }
  return $content.Replace($old, $new)
}

# Validate and patch the Firebase realtime hook.
$hookPath = Join-Path $root 'src\hooks\use-firebase-realtime.ts'
$hook = Get-Content -LiteralPath $hookPath -Raw
$hook = [regex]::Replace($hook, "\r?\n", "`r`n")
if ($hook -notmatch 'export function useFirebaseRealtime\(firebaseToken: string \| null \| undefined, onConnectionChange\?') {
  $hook = Replace-Once $hook `
    'export function useFirebaseRealtime(firebaseToken: string | null | undefined) {' `
    'export function useFirebaseRealtime(firebaseToken: string | null | undefined, onConnectionChange?: (connected: boolean) => void) {' `
    'Firebase hook signature'

  $hook = Replace-Once $hook `
    '    if (!firebaseToken) return' `
    "    if (!firebaseToken) {`r`n      onConnectionChange?.(false)`r`n      return`r`n    }`r`n    onConnectionChange?.(false)" `
    'Firebase token guard'

  $hook = Replace-Once $hook `
    "        const onError = (error: Error) => {`r`n          console.error('[realtime] Firebase event listener failed:', error)`r`n        }" `
    "        const onError = (error: Error) => {`r`n          console.error('[realtime] Firebase event listener failed:', error)`r`n          onConnectionChange?.(false)`r`n        }" `
    'Firebase listener error handler'

  $hook = Replace-Once $hook `
    "        stopBroadcastEvents = attachEventListener(`r`n          ['realtimeBroadcasts'],`r`n          handleEvent,`r`n          onError,`r`n        )" `
    "        stopBroadcastEvents = attachEventListener(`r`n          ['realtimeBroadcasts'],`r`n          handleEvent,`r`n          onError,`r`n        )`r`n        onConnectionChange?.(true)" `
    'Firebase listeners setup'

  $hook = Replace-Once $hook `
    "      } catch (error) {`r`n        console.error('[realtime] Firebase authentication failed:', error)`r`n      }" `
    "      } catch (error) {`r`n        console.error('[realtime] Firebase authentication failed:', error)`r`n        onConnectionChange?.(false)`r`n      }" `
    'Firebase authentication failure handler'

  $hook = Replace-Once $hook `
    "      stopUserEvents?.()`r`n      stopBroadcastEvents?.()`r`n    }`r`n  }, [firebaseToken, queryClient])" `
    "      stopUserEvents?.()`r`n      stopBroadcastEvents?.()`r`n      onConnectionChange?.(false)`r`n    }`r`n  }, [firebaseToken, queryClient, onConnectionChange])" `
    'Firebase hook cleanup and dependencies'
}

# Patch AppRoot to keep the app online through authenticated heartbeat, and show
# the Firebase realtime status instead of only the legacy Socket.IO status.
$appPath = Join-Path $root 'src\components\app-root.tsx'
$app = Get-Content -LiteralPath $appPath -Raw
$app = [regex]::Replace($app, "\r?\n", "`r`n")
if ($app -notmatch "usePresenceHeartbeat") {
  $app = Replace-Once $app `
    "import { useFirebaseRealtime } from '@/hooks/use-firebase-realtime'" `
    "import { useFirebaseRealtime } from '@/hooks/use-firebase-realtime'`r`nimport { usePresenceHeartbeat } from '@/hooks/use-presence-heartbeat'" `
    'presence heartbeat import'

  $oldRealtimeBlock = @'
  const socketToken = session.data?.socketToken ?? null
  const firebaseToken = session.data?.firebaseToken ?? null
  useRealtime(socketToken, profile?.publicId ?? null)
  useFirebaseRealtime(firebaseToken)
'@
  $newRealtimeBlock = @'
  const [firebaseRealtimeReady, setFirebaseRealtimeReady] = useState(false)
  const socketToken = session.data?.socketToken ?? null
  const firebaseToken = session.data?.firebaseToken ?? null
  useRealtime(socketToken, profile?.publicId ?? null)
  useFirebaseRealtime(firebaseToken, setFirebaseRealtimeReady)
  usePresenceHeartbeat(Boolean(profile))
  const realtimeConnected = socketConnected || firebaseRealtimeReady
'@
  $oldRealtimeBlock = [regex]::Replace($oldRealtimeBlock, "\r?\n", "`r`n")
  $newRealtimeBlock = [regex]::Replace($newRealtimeBlock, "\r?\n", "`r`n")
  $app = Replace-Once $app $oldRealtimeBlock $newRealtimeBlock 'AppRoot realtime setup'

  # Match the full title expression without depending on the exact dash character
  # in the source file (which may vary with Windows PowerShell file encodings).
  $titlePattern = 'title=\{socketConnected \? .*?\}'
  $titleReplacement = "title={realtimeConnected ? 'Realtime connected' : 'Realtime offline - retrying'}"
  $titleRegex = [regex]::new($titlePattern)
  if ($titleRegex.Matches($app).Count -ne 1) { throw 'Expected exactly one status title to patch.' }
  $app = $titleRegex.Replace($app, $titleReplacement, 1)
  $app = Replace-Once $app "socketConnected ? 'bg-emerald-400 signal-dot' : 'bg-amber-500'" "realtimeConnected ? 'bg-emerald-400 signal-dot' : 'bg-amber-500'" 'status dot state'
  $app = Replace-Once $app "{socketConnected ? 'Live' : 'Reconnecting'}" "{realtimeConnected ? 'Live' : 'Reconnecting'}" 'status label state'
}

# Change socket disconnect behavior: mark offline only after the server-side
# heartbeat grace period expires. A temporary Socket.IO disconnect must not
# override the authenticated Firestore heartbeat.
$servicePath = Join-Path $root 'mini-services\realtime\service.ts'
$service = Get-Content -LiteralPath $servicePath -Raw
$service = [regex]::Replace($service, "\r?\n", "`r`n")
$oldDisconnectPresence = '        await setOnline(userId, false)'
if ($service.Contains($oldDisconnectPresence)) {
  $disconnectReplacement = @'
        // Presence is maintained by the authenticated HTTP heartbeat as well.
        // Do not mark the user offline for a transient Socket.IO disconnect;
        // sweepPresence() marks them offline after the heartbeat grace period.
'@
  $service = Replace-Once $service $oldDisconnectPresence $disconnectReplacement 'socket disconnect presence handling'
} elseif ($service -notmatch 'Do not mark the user offline for a transient Socket\.IO disconnect') {
  throw "Could not find the expected Socket.IO disconnect presence statement in mini-services\realtime\service.ts."
}

# Write an authenticated heartbeat API route. Admin SDK writes remain server-side.
$routeDir = Join-Path $root 'src\app\api\presence\heartbeat'
New-Item -ItemType Directory -Path $routeDir -Force | Out-Null
$routePath = Join-Path $routeDir 'route.ts'
$route = @'
import { Timestamp } from 'firebase-admin/firestore'
import { handle, ok, unauthorized } from '@/lib/api-helpers'
import { getAuth } from '@/lib/session'
import { getFirebaseAdminFirestore } from '@/lib/firebase-admin'

export const dynamic = 'force-dynamic'

export const POST = handle(async () => {
  const auth = await getAuth()
  if (!auth) throw unauthorized()

  const userId = auth.profile.id
  const firestore = getFirebaseAdminFirestore()
  const presenceRef = firestore.collection('presences').doc(userId)
  const now = Timestamp.now()

  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(presenceRef)
    const existing = current.data() ?? {}
    const lastSeenAt = existing.isOnline === true && existing.lastSeenAt
      ? existing.lastSeenAt
      : now

    transaction.set(presenceRef, {
      userId,
      isOnline: true,
      lastHeartbeatAt: now,
      lastSeenAt,
    }, { merge: true })
  })

  return ok({ online: true, lastHeartbeatAt: now.toDate().toISOString() })
})
'@
if (Test-Path -LiteralPath $routePath) {
  $oldRoute = Get-Content -LiteralPath $routePath -Raw
  if ($oldRoute -notmatch 'lastHeartbeatAt') { throw "The presence heartbeat route already exists with unexpected contents: $routePath" }
} else {
  Set-Content -LiteralPath $routePath -Value $route -Encoding utf8
}

# Add the browser heartbeat hook.
$heartbeatPath = Join-Path $root 'src\hooks\use-presence-heartbeat.ts'
$heartbeat = @'
'use client'

import { useEffect } from 'react'

/** Keeps Firestore presence online while this authenticated app is active. */
export function usePresenceHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return

    let stopped = false
    let requestInFlight = false

    const beat = async () => {
      if (stopped || requestInFlight || document.visibilityState !== 'visible') return
      requestInFlight = true
      try {
        const response = await fetch('/api/presence/heartbeat', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
        })
        if (!response.ok) {
          console.warn(`[presence] heartbeat failed (${response.status})`)
        }
      } catch (error) {
        console.warn('[presence] heartbeat request failed:', error)
      } finally {
        requestInFlight = false
      }
    }

    void beat()
    const timer = window.setInterval(() => void beat(), 20_000)
    const onWake = () => void beat()
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)

    return () => {
      stopped = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [enabled])
}
'@
if (-not (Test-Path -LiteralPath $heartbeatPath)) {
  Set-Content -LiteralPath $heartbeatPath -Value $heartbeat -Encoding utf8
}

# Persist the edited sources only after all required anchor replacements pass.
Set-Content -LiteralPath $hookPath -Value $hook -Encoding utf8
Set-Content -LiteralPath $appPath -Value $app -Encoding utf8
Set-Content -LiteralPath $servicePath -Value $service -Encoding utf8

Write-Host ''
Write-Host 'Hushly Firebase presence patch applied.' -ForegroundColor Green
Write-Host "Backup: $backup"
Write-Host 'Created/verified:'
Write-Host '  src\app\api\presence\heartbeat\route.ts'
Write-Host '  src\hooks\use-presence-heartbeat.ts'
Write-Host ''
Write-Host 'Next run:' -ForegroundColor Cyan
Write-Host '  npx tsc --noEmit'
Write-Host '  npx tsc --noEmit -p mini-services/realtime/tsconfig.json'
Write-Host '  npm run build'
