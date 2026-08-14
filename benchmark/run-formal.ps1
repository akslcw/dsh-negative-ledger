# Formal experiment: 6 scenarios x 3 profiles x 3 iterations = 54 runs,
# then summarize. Requires DEEPSEEK_API_KEY and DSH_CHECKOUT (built checkout).
# Runs are collected per (scenario, profile, iteration) under benchmark/runs;
# failures/timeouts are kept, not retried silently (see BENCHMARK.md).
$ErrorActionPreference = 'Stop'
if (-not $env:DSH_CHECKOUT) { throw 'set DSH_CHECKOUT to the built deepseek-harness checkout' }
if (-not $env:DEEPSEEK_API_KEY) { throw 'set DEEPSEEK_API_KEY' }

$scenarios = @(
  's1-missing-read-repeat',
  's2-search-alternate-path',
  's3-create-then-reread',
  's4-command-ttl-retry',
  's5-parent-child-cross-agent',
  's6-similar-commands-no-false-positive'
)
$profiles = @('baseline', 'warn', 'block')

foreach ($s in $scenarios) {
  foreach ($p in $profiles) {
    foreach ($i in 1..3) {
      node benchmark/run.ts $s $p $i
      if ($LASTEXITCODE -ne 0) { Write-Warning "run failed: $s/$p/$i (exit $LASTEXITCODE); continuing per protocol" }
    }
  }
}

node benchmark/summarize.ts
