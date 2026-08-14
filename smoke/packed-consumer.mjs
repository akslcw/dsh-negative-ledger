// Packed-consumer smoke: verifies the publish artifact from a consumer's
// perspective, cross-platform and without any TS toolchain. It packs the
// current tree (skipping the prepack rebuild — the CI job builds first),
// installs the tarball into a temp project, imports the public ESM entry,
// exercises the sqlite store, and smokes the bin mapping. All child spawns
// use inherited stdio (exit codes carry the verdict), so this also runs in
// piped-stdio-restricted sandboxes.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
// npm run injects npm_execpath (the JS entry), which node can spawn directly;
// .cmd shims cannot be spawned by node on Windows (EINVAL).
function npmRun(args) {
  const npmCli = process.env.npm_execpath
  if (npmCli !== undefined) {
    execFileSync(process.execPath, [npmCli, ...args], { cwd: repoRoot, stdio: 'inherit' })
  } else if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'npm', ...args], { cwd: repoRoot, stdio: 'inherit' })
  } else {
    execFileSync('npm', args, { cwd: repoRoot, stdio: 'inherit' })
  }
}
// npm flattens the scoped name for the tarball filename.
const tarball = join(repoRoot, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`)
const consumer = mkdtempSync(join(tmpdir(), 'negledger-consumer-'))
const ledgerDir = join(consumer, 'ledger')
try {
  npmRun(['pack', '--ignore-scripts'])
  npmRun(['install', '--prefix', consumer, tarball, '--ignore-scripts', '--no-audit', '--no-fund'])
  const probe = [
    `import { SqliteLedgerStore } from '@akslcw/dsh-negative-ledger'`,
    `const store = new SqliteLedgerStore({ dir: ${JSON.stringify(ledgerDir)} })`,
    `const seeded = await store.recordFact({`,
    `  kind: 'command_failed',`,
    `  scope: '',`,
    `  fingerprint: JSON.stringify({ kind: 'command_failed', tool: 'bash', commandLine: 'npm test' }),`,
    `  claim: 'command exited 1 (bash)',`,
    `  evidence: [{ role: 'outcome', kind: 'command-exit', exitCode: 1, stderrSignature: 'x' }],`,
    `}, { operationId: 'consumer-probe' })`,
    `const facts = await store.queryFacts()`,
    `if (facts.length !== 1 || facts[0].fact.id !== seeded.fact.id) throw new Error('store probe failed')`,
    `await store.close()`,
    `console.log('consumer store probe ok')`,
    '',
  ].join('\n')
  writeFileSync(join(consumer, 'probe.mjs'), probe)
  execFileSync(process.execPath, [join(consumer, 'probe.mjs')], { stdio: 'inherit' })
  const bin = join(consumer, 'node_modules', '@akslcw', 'dsh-negative-ledger', 'dist', 'bin.mjs')
  execFileSync(process.execPath, [bin, '--dir', ledgerDir, '--backend', 'sqlite', 'stats'], { stdio: 'inherit' })
  console.log('pack-test ok')
} finally {
  rmSync(tarball, { force: true })
  rmSync(consumer, { recursive: true, force: true })
}
