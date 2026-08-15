import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evidenceSatisfied,
  extractToolCalls,
  extractToolResultTexts,
  finalAssistantVisibleText,
  satisfiedRequiredAllow,
} from '../benchmark/session-log.ts'
import { resolveScenario } from '../benchmark/resolve.ts'
import type { ScenarioSource } from '../benchmark/resolve.ts'

function assistantEvent(blocks: Array<{ type: string; text?: string; id?: string; name?: string }>): Record<string, unknown> {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: blocks } } }
}

function toolCallEvent(callId: string, name: string): Record<string, unknown> {
  return { type: 'tool/call', data: { callId, name, arguments: '{}' } }
}

function toolResultEvent(callId: string, parts: Array<{ text?: string; isError?: boolean }>): Record<string, unknown> {
  return {
    type: 'tool/result',
    data: {
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: parts, isError: parts.some(part => part.isError === true) }],
      },
    },
  }
}

describe('benchmark success extraction', () => {
  it('final assistant visible text excludes reasoning blocks', () => {
    const events = [
      assistantEvent([{ type: 'reasoning', text: '我知道标记会是 REPORT-DONE' }]),
      assistantEvent([{ type: 'reasoning', text: 'final thoughts' }, { type: 'text', text: '最终答案\nREPORT-DONE' }]),
    ]
    assert.equal(finalAssistantVisibleText(events).includes('REPORT-DONE'), true)
    const reasoningOnly = [assistantEvent([{ type: 'reasoning', text: 'REPORT-DONE' }])]
    assert.equal(finalAssistantVisibleText(reasoningOnly), '')
  })

  it('walks back to the last assistant message that carries visible text', () => {
    const events = [
      assistantEvent([{ type: 'text', text: '早期内容' }]),
      assistantEvent([{ type: 'tool-call', id: 'c1', name: 'read' }]),
    ]
    assert.equal(finalAssistantVisibleText(events), '早期内容')
  })

  it('extracts tool output evidence with tool name and error flag', () => {
    const events = [
      toolCallEvent('c1', 'read'),
      toolResultEvent('c1', [{ text: 'CREATED-OK' }]),
      toolCallEvent('c2', 'read'),
      toolResultEvent('c2', [{ text: 'Error: not found', isError: true }]),
    ]
    const results = extractToolResultTexts(events)
    const ok = results.find(result => result.tool === 'read' && !result.isError)
    assert.ok(ok !== undefined && ok.text.includes('CREATED-OK'))
    const failed = results.find(result => result.isError)
    assert.ok(failed !== undefined && failed.tool === 'read')
  })
})

describe('benchmark evidence verdict', () => {
  it('standalone-line matching rejects command echoes that merely contain the marker', () => {
    const echo = { tool: 'pwsh', key: 'cmd-key', text: "if (Test-Path flag.txt) { Write-Output 'FLAKE-OK-7K3Q' } ...\nFLAKE-FAIL\n", isError: false }
    assert.equal(evidenceSatisfied([echo], { marker: 'FLAKE-OK-7K3Q', tool: 'pwsh', repeat: true }), false)
  })

  it('repeat: true binds evidence to the second occurrence of the same call key', () => {
    const first = { tool: 'pwsh', key: 'cmd-key', text: 'FLAKE-FAIL\n', isError: false }
    const second = { tool: 'pwsh', key: 'cmd-key', text: 'FLAKE-OK-7K3Q\n', isError: false }
    assert.equal(evidenceSatisfied([first, second], { marker: 'FLAKE-OK-7K3Q', tool: 'pwsh', repeat: true }), true)
    assert.equal(evidenceSatisfied([second], { marker: 'FLAKE-OK-7K3Q', tool: 'pwsh', repeat: true }), false)
  })

  it('error results never satisfy evidence even on a standalone line', () => {
    const failed = { tool: 'read', key: 'r-key', text: 'CREATED-OK\n', isError: true }
    assert.equal(evidenceSatisfied([failed], { marker: 'CREATED-OK', tool: 'read' }), false)
  })

  it('unrelated keys do not satisfy a repeat requirement', () => {
    const other = { tool: 'read', key: 'other-key', text: 'AAA-STABLE\n', isError: false }
    assert.equal(evidenceSatisfied([other], { marker: 'AAA-STABLE', tool: 'read', repeat: true }), false)
  })
})

describe('benchmark read structured evidence (real DSH format)', () => {
  // Verbatim shape captured from a real successful read of a one-line file:
  // the display text renders "1: ALT-CONTENT-42" while the authoritative
  // line output lives in data.meta.lines[].text.
  function realReadResult(callId: string): Record<string, unknown> {
    return {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: '<path>notes/alt.txt</path>\n<type>file</type>\n<content>\n1: ALT-CONTENT-42\n\n(End of file - total 1 lines)\n</content>' }],
            isError: false,
          }],
          role: 'user',
        },
        meta: { path: 'notes/alt.txt', offset: 1, lines: [{ number: 1, text: 'ALT-CONTENT-42' }], totalLines: 1 },
      },
    }
  }

  it('extracts evidence from meta.lines, not the numbered display text', () => {
    const events = [toolCallEvent('c-read', 'read'), realReadResult('c-read')]
    const results = extractToolResultTexts(events)
    assert.equal(results.length, 1)
    assert.equal(results[0]?.text, 'ALT-CONTENT-42')
    assert.equal(results[0]?.isError, false)
    assert.equal(evidenceSatisfied(results, { marker: 'ALT-CONTENT-42', tool: 'read' }), true)
  })

  it('the display form "1: <marker>" would fail standalone-line equality (why structured is required)', () => {
    assert.equal('1: ALT-CONTENT-42'.trim() === 'ALT-CONTENT-42', false)
    const displayOnly = [{ tool: 'read', key: 'k', text: '1: ALT-CONTENT-42\n', isError: false }]
    assert.equal(evidenceSatisfied(displayOnly, { marker: 'ALT-CONTENT-42', tool: 'read' }), false)
  })

  it('failed reads without meta keep the error display text and never satisfy evidence', () => {
    const failed = {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'c-fail' },
          content: [{
            type: 'tool-result',
            toolCallId: 'c-fail',
            content: [{ type: 'text', text: 'Error: cannot read "missing.txt": not found' }],
            isError: true,
          }],
        },
        error: { name: 'FsError', code: 'FS_NOT_FOUND' },
      },
    }
    const results = extractToolResultTexts([toolCallEvent('c-fail', 'read'), failed])
    assert.equal(results[0]?.isError, true)
    assert.equal(evidenceSatisfied(results, { marker: 'ALT-CONTENT-42', tool: 'read' }), false)
  })
})

describe('benchmark shell exit-code failure recognition (real DSH format)', () => {
  // DSH shell tools report non-zero exits as successful results whose text
  // carries `[exit code: N]`; captured from the s4 formal-round logs.
  const command = "if (Test-Path flag.txt) { Write-Output 'FLAKE-OK-7K3Q' } else { Write-Error 'FLAKE-FAIL'; exit 1 }"
  const failOutput = `if (Test-Path flag.txt) { Write-Output 'FLAKE-OK-7K3Q' } else { Write-Error 'FLAKE-FAIL'; exit 1 }\nFLAKE-FAIL\n[exit code: 1]\n`
  const okOutput = `if (Test-Path flag.txt) { Write-Output 'FLAKE-OK-7K3Q' } else { Write-Error 'FLAKE-FAIL'; exit 1 }\nFLAKE-OK-7K3Q\n[exit code: 0]\n`

  function pwshCallEvent(callId: string): Record<string, unknown> {
    return { type: 'tool/call', data: { callId, name: 'pwsh', arguments: JSON.stringify({ command }) } }
  }

  function pwshResultEvent(callId: string, output: string): Record<string, unknown> {
    return {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: output }], isError: false }],
        },
      },
    }
  }

  const ttlSequence = [pwshCallEvent('c1'), pwshResultEvent('c1', failOutput), pwshCallEvent('c2'), pwshResultEvent('c2', okOutput)]

  it('recognizes [exit code: 1] as a failed command and [exit code: 0] as success', () => {
    const calls = extractToolCalls(ttlSequence)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.isError, true)
    assert.equal(calls[0]?.ok, false)
    assert.equal(calls[0]?.errorText, '[exit code: 1]')
    assert.equal(calls[1]?.isError, false)
    assert.equal(calls[1]?.ok, true)
  })

  it('counts the s4 TTL sequence as a satisfied requiredAllow entry', () => {
    const calls = extractToolCalls(ttlSequence)
    assert.equal(satisfiedRequiredAllow([{ tool: 'pwsh', commandLinePrefix: command }], calls), 1)
  })

  it('without the failedOnce precondition the entry is not satisfied', () => {
    const onlySuccess = [pwshCallEvent('c1'), pwshResultEvent('c1', okOutput)]
    assert.equal(satisfiedRequiredAllow([{ tool: 'pwsh', commandLinePrefix: command }], extractToolCalls(onlySuccess)), 0)
  })

  it('excludes the failed exit from evidence and lets the retry satisfy it', () => {
    const results = extractToolResultTexts(ttlSequence)
    assert.equal(results[0]?.isError, true)
    assert.equal(evidenceSatisfied(results, { marker: 'FLAKE-OK-7K3Q', tool: 'pwsh', repeat: true }), true)
  })

  it('read results whose file content contains [exit code: 1] stay successful', () => {
    const readCall = { type: 'tool/call', data: { callId: 'rc1', name: 'read', arguments: JSON.stringify({ file_path: 'notes.txt' }) } }
    const readResult = {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'rc1' },
          content: [{ type: 'tool-result', toolCallId: 'rc1', content: [{ type: 'text', text: '<path>notes.txt</path>\n<type>file</type>\n<content>\n1: [exit code: 1]\n\n(End of file - total 1 lines)\n</content>' }], isError: false }],
        },
        meta: { path: 'notes.txt', offset: 1, lines: [{ number: 1, text: '[exit code: 1]' }], totalLines: 1 },
      },
    }
    const events = [readCall, readResult]
    const calls = extractToolCalls(events)
    assert.equal(calls[0]?.isError, false)
    assert.equal(calls[0]?.ok, true)
    const results = extractToolResultTexts(events)
    assert.equal(results[0]?.isError, false)
    assert.equal(evidenceSatisfied(results, { marker: '[exit code: 1]', tool: 'read' }), true)
  })

  it('bash results follow the same non-zero exit recognition', () => {
    const bashCall = { type: 'tool/call', data: { callId: 'bc1', name: 'bash', arguments: JSON.stringify({ command: 'false' }) } }
    const bashResult = {
      type: 'tool/result',
      data: {
        message: {
          source: { kind: 'tool', callId: 'bc1' },
          content: [{ type: 'tool-result', toolCallId: 'bc1', content: [{ type: 'text', text: 'false\n[exit code: 2]\n' }], isError: false }],
        },
      },
    }
    const calls = extractToolCalls([bashCall, bashResult])
    assert.equal(calls[0]?.isError, true)
    assert.equal(calls[0]?.errorText, '[exit code: 2]')
  })
})

describe('benchmark scenario resolution', () => {
  const source: ScenarioSource = {
    id: 's4-test',
    title: 't',
    timeoutMs: 1,
    tokenBudget: 1,
    success: { report: 'REPORT-DONE', evidence: { marker: 'FLAKE-OK-7K3Q', tool: '__SHELL__', repeat: true } },
    requiredAllow: [{ tool: '__SHELL__', commandLinePrefix: '__SHELL_COMMAND__' }],
    mustNeverDeny: [],
    command: { windows: 'W-CMD', posix: 'P-CMD' },
    sleep: { windows: 'W-SLEEP', posix: 'P-SLEEP' },
    prompt: 'run: __SHELL_COMMAND__ then __SLEEP_COMMAND__',
  }

  it('resolves pwsh + windows command + sleep on win32', () => {
    const resolved = resolveScenario(source, 'win32')
    assert.equal(resolved.shellTool, 'pwsh')
    assert.equal(resolved.command, 'W-CMD')
    assert.equal(resolved.sleep, 'W-SLEEP')
    assert.equal(resolved.prompt, 'run: W-CMD then W-SLEEP')
    assert.equal(resolved.success.evidence?.tool, 'pwsh')
    assert.equal(resolved.success.evidence?.repeat, true)
    assert.equal(resolved.requiredAllow[0]?.tool, 'pwsh')
    assert.equal(resolved.requiredAllow[0]?.commandLinePrefix, 'W-CMD')
  })

  it('resolves bash + posix command + sleep elsewhere', () => {
    const resolved = resolveScenario(source, 'linux')
    assert.equal(resolved.shellTool, 'bash')
    assert.equal(resolved.command, 'P-CMD')
    assert.equal(resolved.sleep, 'P-SLEEP')
    assert.equal(resolved.prompt, 'run: P-CMD then P-SLEEP')
    assert.equal(resolved.success.evidence?.tool, 'bash')
    assert.equal(resolved.requiredAllow[0]?.tool, 'bash')
    assert.equal(resolved.requiredAllow[0]?.commandLinePrefix, 'P-CMD')
  })

  it('leaves shell-less scenarios untouched', () => {
    const plain: ScenarioSource = {
      id: 's4-plain',
      title: 't',
      timeoutMs: 1,
      tokenBudget: 1,
      success: { report: 'X' },
      requiredAllow: [],
      mustNeverDeny: [],
      prompt: 'plain',
    }
    const resolved = resolveScenario(plain, 'win32')
    assert.equal(resolved.shellTool, null)
    assert.equal(resolved.command, null)
    assert.equal(resolved.sleep, null)
    assert.equal(resolved.prompt, 'plain')
  })
})
