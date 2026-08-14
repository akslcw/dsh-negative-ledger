// Platform resolution for benchmark scenarios. Scenarios are authored once
// and resolved per platform: the shell tool differs (pwsh on Windows, bash
// elsewhere), so s4 declares both command variants and the runner picks one.
// The resolved scenario is written into the run dir and is the single source
// of truth for the collector and the summarizer.

export interface AllowEntry {
  tool: string
  path?: string
  commandLinePrefix?: string
}

export interface SuccessSpec {
  report: string
  evidence?: { marker: string; tool?: string; repeat?: boolean }
}

export interface ScenarioSource {
  id: string
  title: string
  timeoutMs: number
  tokenBudget: number
  success: SuccessSpec
  requiredAllow: AllowEntry[]
  mustNeverDeny: AllowEntry[]
  command?: { windows: string; posix: string }
  sleep?: { windows: string; posix: string }
  prompt: string
}

export interface ResolvedScenario {
  id: string
  title: string
  timeoutMs: number
  tokenBudget: number
  success: SuccessSpec
  requiredAllow: AllowEntry[]
  mustNeverDeny: AllowEntry[]
  shellTool: 'pwsh' | 'bash' | null
  command: string | null
  sleep: string | null
  prompt: string
}

/** The DSH shell tool name for a platform. */
export function shellToolFor(platform: NodeJS.Platform): 'pwsh' | 'bash' {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/** Replace `__SHELL__` and `__SHELL_COMMAND__` placeholders in one entry. */
function resolveEntry(entry: AllowEntry, shellTool: string, command: string | null): AllowEntry {
  const resolved: AllowEntry = { tool: entry.tool === '__SHELL__' ? shellTool : entry.tool }
  if (entry.path !== undefined) resolved.path = entry.path
  if (entry.commandLinePrefix !== undefined) {
    resolved.commandLinePrefix = entry.commandLinePrefix === '__SHELL_COMMAND__' ? (command ?? '') : entry.commandLinePrefix
  }
  return resolved
}

/**
 * Resolve a scenario for one platform: prompt placeholders, the shell tool
 * name, and the platform-specific command.
 */
export function resolveScenario(def: ScenarioSource, platform: NodeJS.Platform): ResolvedScenario {
  const shellTool = def.command !== undefined ? shellToolFor(platform) : null
  const command = def.command !== undefined ? (platform === 'win32' ? def.command.windows : def.command.posix) : null
  const sleep = def.sleep !== undefined ? (platform === 'win32' ? def.sleep.windows : def.sleep.posix) : null
  let prompt = def.prompt
  if (command !== null) prompt = prompt.replaceAll('__SHELL_COMMAND__', command)
  if (sleep !== null) prompt = prompt.replaceAll('__SLEEP_COMMAND__', sleep)
  const sourceEvidence = def.success.evidence
  let success: SuccessSpec = { report: def.success.report }
  if (sourceEvidence !== undefined) {
    const evidenceTool = sourceEvidence.tool === '__SHELL__' ? shellTool : sourceEvidence.tool
    const evidence: SuccessSpec['evidence'] = {
      marker: sourceEvidence.marker,
      ...(evidenceTool !== null && evidenceTool !== undefined ? { tool: evidenceTool } : {}),
      ...(sourceEvidence.repeat === true ? { repeat: true } : {}),
    }
    success = { report: def.success.report, evidence }
  }
  return {
    id: def.id,
    title: def.title,
    timeoutMs: def.timeoutMs,
    tokenBudget: def.tokenBudget,
    success,
    requiredAllow: def.requiredAllow.map(entry => resolveEntry(entry, shellTool ?? '', command)),
    mustNeverDeny: def.mustNeverDeny.map(entry => resolveEntry(entry, shellTool ?? '', command)),
    shellTool,
    command,
    sleep,
    prompt,
  }
}
