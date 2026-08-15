# Clean-environment install smoke for @akslcw/dsh-negative-ledger.
# Runs the one-command install contract end to end:
#   add -> layer visible in --dump-config -> headless run exercises warn +
#   sqlite ledger -> remove -> layer gone, profile still boots.
#
# Usage (user machine, built DSH CLI available as `dsh`, DEEPSEEK_API_KEY set):
#   powershell -File smoke/plugin-add-smoke.ps1
$ErrorActionPreference = 'Stop'
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) { throw 'dsh not on PATH' }
if (-not $env:DEEPSEEK_API_KEY) { throw 'set DEEPSEEK_API_KEY' }

$home = Join-Path $env:TEMP ('dsh-smoke-home-' + [guid]::NewGuid().ToString('N'))
$work = Join-Path $env:TEMP ('dsh-smoke-workspace-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$env:DSH_HOME = $home

try {
  Write-Host '[1/5] dsh plugin add @akslcw/dsh-negative-ledger'
  $add = dsh plugin --profile headless add @akslcw/dsh-negative-ledger 2>&1 | Out-String
  # pnpm >=11 hard-fails on ignored build scripts (better-sqlite3). Its
  # prebuilds make the ignored script harmless; relax to a warning and retry.
  if ($LASTEXITCODE -ne 0 -and $add -match 'IGNORED_BUILDS') {
    Push-Location (Join-Path $home 'profiles\headless')
    pnpm config set --location project strict-dep-builds false | Out-Null
    Pop-Location
    $add = dsh plugin --profile headless add @akslcw/dsh-negative-ledger 2>&1 | Out-String
  }
  if ($LASTEXITCODE -ne 0) { throw "plugin add failed: $add" }

  Write-Host '[2/5] --dump-config shows the bundle layer'
  $config = dsh --profile headless --dump-config
  if ($config -notmatch 'negative-ledger') { throw 'negative-ledger row not in composed config' }
  if ($config -notmatch '@akslcw/dsh-negative-ledger') { throw 'bundle layer missing' }

  Write-Host '[3/5] headless run: warn injection + sqlite ledger'
  Push-Location $work
  $out = dsh --profile headless @"
工作目录下不存在 missing-smoke.txt。请依次用 read 工具读取它两次（文件路径参数为 missing-smoke.txt），第二次之后如果运行环境注入的提示要求你不要重复相同操作，就停止并说明。最后一行单独输出：SMOKE-DONE
"@
  Pop-Location
  if ($LASTEXITCODE -ne 0) { throw 'headless run failed' }
  if ($out -notmatch 'SMOKE-DONE') { throw 'task did not complete' }
  $ledger = Join-Path $work '.ledger\ledger.db'
  if (-not (Test-Path $ledger)) { throw "default sqlite ledger not created at $ledger" }
  dsh-negative-ledger --dir (Join-Path $work '.ledger') --backend sqlite stats

  Write-Host '[4/5] dsh plugin remove'
  dsh plugin --profile headless remove @akslcw/dsh-negative-ledger
  if ($LASTEXITCODE -ne 0) { throw 'plugin remove failed' }

  Write-Host '[5/5] layer gone, profile still boots'
  $config2 = dsh --profile headless --dump-config
  if ($config2 -match 'negative-ledger') { throw 'layer survived removal' }

  Write-Host 'SMOKE PASS'
} finally {
  $env:DSH_HOME = $null
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
