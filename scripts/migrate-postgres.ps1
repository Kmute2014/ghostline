param(
  [string]$SourceUrl = $env:SOURCE_DATABASE_URL,
  [string]$TargetUrl = $env:TARGET_DATABASE_URL
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceUrl) -or [string]::IsNullOrWhiteSpace($TargetUrl)) {
  throw 'Set SOURCE_DATABASE_URL (current Supabase Postgres) and TARGET_DATABASE_URL (new Cloud SQL Postgres) first.'
}

if ($SourceUrl -eq $TargetUrl) {
  throw 'Source and target database URLs must be different.'
}

foreach ($tool in @('pg_dump', 'pg_restore', 'psql')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Required PostgreSQL client tool '$tool' is not installed or not on PATH."
  }
}

$targetTables = & psql $TargetUrl -X -A -t -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%' AND tablename <> 'sql_features' ORDER BY tablename;"
if ($LASTEXITCODE -ne 0) {
  throw 'Could not inspect the Cloud SQL target. Check TARGET_DATABASE_URL and network access.'
}
if (-not [string]::IsNullOrWhiteSpace(($targetTables -join '').Trim())) {
  throw 'Cloud SQL target is not empty. Refusing to overwrite existing tables.'
}

$dumpPath = Join-Path ([System.IO.Path]::GetTempPath()) "ghostline-postgres-$([guid]::NewGuid().ToString('N')).dump"
try {
  & pg_dump --format=custom --no-owner --no-acl --file=$dumpPath $SourceUrl
  if ($LASTEXITCODE -ne 0) {
    throw 'pg_dump failed; the target database was not changed.'
  }

  & pg_restore --no-owner --no-acl --exit-on-error --dbname=$TargetUrl $dumpPath
  if ($LASTEXITCODE -ne 0) {
    throw 'pg_restore failed. Inspect the target database before retrying.'
  }

  Write-Output 'PostgreSQL data import completed. Keep the Supabase database unchanged until application validation succeeds.'
}
finally {
  if (Test-Path -LiteralPath $dumpPath) {
    Remove-Item -LiteralPath $dumpPath -Force
  }
}
