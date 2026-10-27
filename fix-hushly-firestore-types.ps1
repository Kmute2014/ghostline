$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath 'src/app/api/conversations/route.ts')) {
  throw 'Run this script from the Hushly project root (D:\hush).'
}

$changes = @(
  [pscustomobject]@{
    Path = 'src/app/api/conversations/route.ts'
    Old = "conversation.type !== 'group'"
    New = "(conversation as any).type !== 'group'"
  },
  [pscustomobject]@{
    Path = 'src/app/api/groups/route.ts'
    Old = '    presenceByUser,'
    New = '    presenceByUser as Parameters<typeof toConversationSummary>[3],'
  },
  [pscustomobject]@{
    Path = 'src/app/api/groups/join/route.ts'
    Old = '    presenceByUser,'
    New = '    presenceByUser as Parameters<typeof toConversationSummary>[3],'
  },
  [pscustomobject]@{
    Path = 'src/app/api/posts/route.ts'
    Old = 'normalizeFirestoreValue({ id: meId, ...(authorSnap.data() ?? auth.profile) })'
    New = 'normalizeFirestoreValue({ ...(authorSnap.data() ?? auth.profile), id: meId })'
  },
  [pscustomobject]@{
    Path = 'src/app/api/stories/route.ts'
    Old = 'stories: [], hasUnseen: false,'
    New = 'stories: [] as ReturnType<typeof toStoryDTO>[], hasUnseen: false,'
  }
)

# Validate every expected source pattern before changing anything.
$pending = @()
foreach ($change in $changes) {
  if (-not (Test-Path -LiteralPath $change.Path)) {
    throw "Required source file not found: $($change.Path)"
  }
  $content = Get-Content -LiteralPath $change.Path -Raw
  if ($content.Contains($change.New)) {
    Write-Host "Already fixed: $($change.Path)"
    continue
  }
  if (-not $content.Contains($change.Old)) {
    throw "Expected source text was not found in $($change.Path). No changes have been made."
  }
  $pending += $change
}

if ($pending.Count -eq 0) {
  Write-Host 'All five TypeScript fixes are already present.'
} else {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupRoot = Join-Path (Get-Location).Path ".ts-fix-backups\$stamp"

  # Back up all affected files before editing any of them.
  foreach ($change in $pending) {
    $backupPath = Join-Path $backupRoot $change.Path
    New-Item -ItemType Directory -Path (Split-Path $backupPath -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $change.Path -Destination $backupPath -Force
  }

  foreach ($change in $pending) {
    $content = Get-Content -LiteralPath $change.Path -Raw
    $updated = $content.Replace($change.Old, $change.New)
    Set-Content -LiteralPath $change.Path -Value $updated -Encoding UTF8
    Write-Host "Fixed: $($change.Path)"
  }

  Write-Host "Backups: $backupRoot"
}

# The installer payload has already been applied. Its copied src/ files must not
# be included in TypeScript checks; remove the extracted payload if it is unlocked.
if (Test-Path -LiteralPath '.\firestore-route-batch') {
  try {
    Remove-Item -LiteralPath '.\firestore-route-batch' -Recurse -Force -ErrorAction Stop
    Write-Host 'Removed extracted firestore-route-batch folder.'
  } catch {
    Write-Warning 'Could not remove .\firestore-route-batch because another process appears to be using it.'
    Write-Warning 'Close any terminal/editor window whose working folder is inside that package, then remove it before running tsc.'
  }
}

Write-Host ''
Write-Host 'Next run: npx tsc --noEmit'
