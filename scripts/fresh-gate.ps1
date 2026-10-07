# R18-A — the fresh-clone gate runs INSIDE the workspace.
#
# Round 17 lost this gate because the clone went to the OS temp directory, which is outside
# the folders this workspace may write to. So the clone lives in `.fresh/` at the git root,
# which is gitignored, and the whole thing is one command.
#
#     git clone . .fresh/elix          (from the git root)
#     cd .fresh/elix/Elix
#     pnpm install --frozen-lockfile
#     pnpm typecheck
#     pnpm lint
#     pnpm test
#
# Delete `.fresh/` before each run, so a stale clone can never be mistaken for a fresh one.

# pnpm writes its command banner to stderr, which PowerShell would treat as a terminating
# error under 'Stop'. So the preference stays Continue and every gate is judged by its OWN
# exit code, which is the only thing that means anything here.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot   # the git root (…\Elix)
$fresh = Join-Path $root '.fresh'

if (Test-Path $fresh) { Remove-Item $fresh -Recurse -Force }
New-Item -ItemType Directory -Path $fresh | Out-Null

Write-Host "== cloning into .fresh/elix =="
git clone --quiet $root (Join-Path $fresh 'elix')
if ($LASTEXITCODE -ne 0) { Write-Host "CLONE FAILED"; exit 1 }

$project = Join-Path $fresh 'elix\Elix'
Push-Location $project
try {
  Write-Host "== install =="
  pnpm.cmd install --frozen-lockfile 2>&1 | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0) { Write-Host "INSTALL FAILED"; exit 1 }

  Write-Host "== typecheck =="
  pnpm.cmd typecheck 2>&1 | Select-String 'error TS' | Select-Object -First 5
  $tc = $LASTEXITCODE
  Write-Host "typecheck exit = $tc"

  Write-Host "== lint =="
  pnpm.cmd lint 2>&1 | Select-Object -Last 2
  $lint = $LASTEXITCODE
  Write-Host "lint exit = $lint"

  Write-Host "== test =="
  $out = Join-Path $env:TEMP 'r18-fresh-test.txt'
  pnpm.cmd test 2>&1 | Out-File -Encoding utf8 $out
  $raw = (Get-Content $out -Raw) -replace "$([char]27)\[[0-9;]*m", ''
  Remove-Item $out -Force
  ($raw -split "`n" | Where-Object { $_ -match '^ *(Tests|Test Files) ' }) | ForEach-Object { $_.Trim() }
  ($raw -split "`n" | Where-Object { $_ -match 'FAIL ' }) | Select-Object -First 5
  $test = $LASTEXITCODE
  Write-Host "test exit = $test"

  if ($tc -ne 0 -or $lint -ne 0 -or $test -ne 0) { Write-Host "FRESH-CLONE GATE FAILED"; exit 1 }
  Write-Host "== FRESH-CLONE GATE: GREEN =="
}
finally {
  Pop-Location
  Remove-Item $fresh -Recurse -Force -ErrorAction SilentlyContinue
}