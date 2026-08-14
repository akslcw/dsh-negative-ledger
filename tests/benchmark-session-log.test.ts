import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evidenceSatisfied, extractToolResultTexts, finalAssistantVisibleText } from '../benchmark/session-log.ts'
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
