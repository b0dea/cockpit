// Claude Code runs the hooks a skill's or a command's frontmatter registers, outside the guard
// (measured on 2.1.323, 2026-11-13), and its documentation says an agent's frontmatter registers hooks
// and MCP servers too. A skill or command body can also run a shell command as it loads (`!` before a
// backtick span), and `allowed-tools` can grant the shell without a prompt. A Write or Edit of such a
// file, or a Git verb that checks one out, is admitted only when the text it leaves does none of these;
// the evaluator asks for any other writer, which carries no text to read.
import { posix } from 'node:path'

import { parse } from 'yaml'

import { agentInstructionFile, foldGuardSpelling, type GuardDecision } from './evaluator.js'
import type { GuardFileContent } from './invocation-parser.js'
import { proposedText } from './policy-pin.js'

/**
 * Why an instruction file's `text` may run something outside the guard, or undefined when it cannot: a
 * shell expansion anywhere in it, or frontmatter that registers hooks or MCP servers or grants the
 * shell. Text that does not open with `---` has no frontmatter; frontmatter that does not parse as
 * YAML, with merge keys and unique keys, is not proven to do none of these.
 */
export function instructionRisk(text: string): string | undefined {
    // Claude Code 2.1.323 runs both `!` before a backtick span and a fence opened with `!`.
    if (text.includes('!`') || /`{3,}!/.test(text)) return 'it runs a shell command as it loads (`!` before a backtick span, or a fence opened with `!`)'
    const lines = text.replace(/^﻿/, '').split(/\r?\n/)
    const start = lines.findIndex(line => line.trim() !== '')
    if (start < 0 || lines[start]!.trim() !== '---') return undefined
    const end = lines.findIndex((line, at) => at > start && /^(?:---|\.\.\.)\s*$/.test(line))
    let data: unknown
    try { data = parse(lines.slice(start + 1, end < 0 ? undefined : end).join('\n'), { merge: true, uniqueKeys: true }) }
    catch (error) { return `its frontmatter does not parse (${error instanceof Error ? error.message.split('\n')[0] : String(error)})` }
    const keys = data !== null && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : []
    const registering = keys.find(key => /^(?:hooks|mcpservers)$/i.test(key.trim()))
    if (registering !== undefined) return `its frontmatter sets ${registering}`
    const tools = keys.find(key => /^allowed[-_]tools$/i.test(key.trim()))
    if (tools !== undefined && /\bbash\b/i.test(JSON.stringify((data as Record<string, unknown>)[tools]))) return 'its frontmatter grants the shell in allowed-tools'
    return undefined
}

/** The ask for a Write or Edit of an agent instruction file whose resulting frontmatter may register hooks or MCP servers. */
export function instructionFrontmatterAsk(input: Readonly<{ tool: string; cwd: string; paths: readonly string[]; content?: GuardFileContent }>,
    read: (path: string) => string | undefined): GuardDecision | undefined {
    if (input.tool !== 'Write' && input.tool !== 'Edit') return undefined
    const target = input.paths.map(path => posix.resolve(input.cwd, path)).find(path => agentInstructionFile(foldGuardSpelling(path)))
    if (target === undefined) return undefined
    const ask = (why: string): GuardDecision => ({ decision: 'ask', reason: `${posix.relative(input.cwd, target) || target} is a skill, command or agent file, and ${why}: Claude Code runs what it registers, expands or grants outside the guard. A person approves this change.` })
    if (!input.content || input.content.kind === 'patch') return ask('the guard was not given the text the change leaves')
    const isTarget = (path: string) => posix.resolve(input.cwd, path) === target
    const proposed = input.content.kind === 'write' ? input.content.content : proposedText(input.content, isTarget, read(target) ?? '')
    if (proposed === undefined || proposed === 'untouched') return ask('the edit does not apply exactly once to its current text')
    const why = instructionRisk(proposed)
    return why === undefined ? undefined : ask(why)
}
