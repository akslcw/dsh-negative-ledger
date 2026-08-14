# Formal experiment: 6 scenarios x 3 profiles x 3 iterations = 54 runs.
# The run order is shuffled with a fixed-seed PRNG (xorshift32) so every
# profile sees the same time-of-day/rate conditions in expectation; the
# planned order is written to runs/formal-plan.json before any run, and
# runs/manifest.jsonl records the actual order with timestamps.
#
# Usage:
#   .\benchmark\run-formal.ps1            # full 54-run experiment + summarize
#   .\benchmark\run-formal.ps1 -PlanOnly  # write and print the plan, run nothing
#
# Requires DEEPSEEK_API_KEY and DSH_CHECKOUT (built checkout).
param(
  [switch]$PlanOnly
)
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_CHECKOUT) { throw 'set DSH_CHECKOUT to the built deepseek-harness checkout' }
if (-not $PlanOnly -and -not $env:DEEPSEEK_API_KEY) { throw 'set DEEPSEEK_API_KEY' }

$seed = if ($env:NEGLEDGER_SEED) { [int]$env:NEGLEDGER_SEED } else { 20260814 }
# System.Random with a fixed seed: deterministic per seed, well-tested
# distribution. The planned order is written to disk before any run, so the
# plan is the reproducibility artifact, not the PRNG implementation.
$rng = [System.Random]::new($seed)

$scenarios = @(
  's1-missing-read-repeat',
  's2-search-alternate-path',
  's3-create-then-reread',
  's4-command-ttl-retry',
  's5-parent-child-cross-agent',
  's6-similar-commands-no-false-positive'
)
$profiles = @('baseline', 'warn', 'block')

$combos = foreach ($s in $scenarios) { foreach ($p in $profiles) { foreach ($i in 1..3) { [pscustomobject]@{ scenario = $s; profile = $p; iteration = $i } } } }
for ($i = $combos.Count - 1; $i -gt 0; $i--) {
  $j = $rng.Next(0, $i + 1)
  $tmp = $combos[$i]; $combos[$i] = $combos[$j]; $combos[$j] = $tmp
}

$order = for ($n = 0; $n -lt $combos.Count; $n++) {
  [pscustomobject]@{ seq = $n + 1; scenario = $combos[$n].scenario; profile = $combos[$n].profile; iteration = $combos[$n].iteration }
}
New-Item -ItemType Directory -Force -Path benchmark\runs | Out-Null
$plan = @{
  seed = $seed
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  tool = 'benchmark/run-formal.ps1'
  checkout = $env:DSH_CHECKOUT
  node = (node --version)
  order = $order
} | ConvertTo-Json -Depth 5
Set-Content -Path benchmark\runs\formal-plan.json -Value $plan
Write-Host "plan: $($combos.Count) runs, seed $seed -> benchmark/runs/formal-plan.json"
$order | Format-Table seq, scenario, profile, iteration -AutoSize | Out-String | Write-Host
if ($PlanOnly) { exit 0 }

foreach ($c in $combos) {
  node benchmark/run.ts $c.scenario $c.profile $c.iteration
  if ($LASTEXITCODE -ne 0) { Write-Warning "run failed: $($c.scenario)/$($c.profile)/$($c.iteration) (exit $LASTEXITCODE); continuing per protocol" }
}

node benchmark/summarize.ts
