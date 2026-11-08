import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import { runCli } from '../cli.js'
import { renderHumanDiagnostics } from '../diagnostics.js'
import { executeProbe } from '../environment-exec/execute.js'
import { runConfiguredSurfaceSelftestOutcome, runSelftestOperatorCommand, runSurfaceSelftestApplication } from '../environment/selftest-application.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'
import { sha256Hex } from '../sha256.js'
import { draftSurfaceSelftestSpecifications, surfaceSelftestExpectation } from '../surfaces/selftest.js'
import { validateSelftestEvidenceBundle } from '../../libexec/validate-harness-evidence.mjs'
import { encodeGuardLocalIdentity, parseGuardLocalIdentity } from '../guards/local-identity.js'

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

const NATIVE_HARNESS = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const claude = path.basename(process.argv[1]) === 'claude'
const args = process.argv.slice(2)
if (args[0] === '--version') console.log(claude ? '0.0.0-synthetic (Claude Code)' : 'codex-cli 0.0.0-synthetic')
else if (args[0] === '--help') console.log('synthetic native harness help: exec --print --settings')
else if (args[0] === 'debug') {
 const bytes = fs.readFileSync('AGENTS.md', 'utf8')
 console.log(JSON.stringify([{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions for '+process.cwd()+'\\n\\n<INSTRUCTIONS>\\n'+bytes+'\\n</INSTRUCTIONS>'}]}]))
} else if (args.includes('--include-hook-events')) {
 const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'))
 // Like Claude Code, every PreToolUse registration whose matcher selects Bash runs: cockpit's beside the team's.
 const hooks=settings.hooks.PreToolUse.filter(group=>new RegExp('^(?:'+group.matcher+')$').test('Bash')).flatMap(group=>group.hooks.map(hook=>hook.command))
 const broken=hooks.some(hook=>hook.startsWith('cockpit-selftest-missing-hook-'))
 const endpoint=process.env.ANTHROPIC_BASE_URL, nonce=endpoint.split('/').at(-1)
 const messages=[{role:'user',content:[{type:'text',text:args.at(-1)}]}]
 async function request() {
  const response=await fetch(endpoint+'/v1/messages',{method:'POST',body:JSON.stringify({messages})})
  const body=await response.text()
  if(!response.ok)throw new Error('capture failed')
  const events=body.split(String.fromCharCode(10)).filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)))
  const block=events.find(e=>e.type==='content_block_start')?.content_block
  if(block?.type!=='tool_use')return
  block.input=JSON.parse(events.find(e=>e.delta?.type==='input_json_delta').delta.partial_json)
  if(!args.includes('Bash('+block.input.command+')'))throw new Error('command is not explicitly granted')
  console.log(JSON.stringify({type:'assistant',message:{content:[block]}}))
  messages.push({role:'assistant',content:[block]})
  const decision={permissionDecision:'deny',permissionDecisionReason:'Refusing executable use of a declared vendor host.'}
  const responses=hooks.map(hook=>{
   if(hook.startsWith('cockpit-selftest-missing-hook-'))return {exit_code:127,stdout:'',stderr:hook+': command not found'}
   if(hook.includes('.cockpit/guards/bash-guard.sh'))return {exit_code:0,stdout:block.id==='cockpit_forbidden'?JSON.stringify({hookSpecificOutput:decision}):'',stderr:''}
   const run=require('node:child_process').spawnSync('/bin/sh',['-c',hook],{encoding:'utf8',env:{...process.env,CLAUDE_PROJECT_DIR:process.cwd()},
    input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:block.input})})
   return {exit_code:run.status,stdout:run.stdout,stderr:run.stderr}
  })
  for(const response of responses)console.log(JSON.stringify({type:'system',subtype:'hook_response',hook_name:'PreToolUse:Bash',hook_event:'PreToolUse',...response}))
  const blocked=responses.find(response=>response.exit_code===2)
  const denied=blocked!==undefined || responses.some(response=>response.stdout.includes('"deny"'))
  let content=blocked?blocked.stderr:denied?'Denied by hook':'COCKPIT_GUARD_ORDINARY_'+nonce
  if(!denied && block.id==='cockpit_forbidden') {
   const host=block.input.command.split('http://')[1].split('/')[0]
   content=await new Promise((resolve,reject)=>require('node:http').get(endpoint+'/guard-receipt',{headers:{host}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve(text))}).on('error',reject))
  }
  const result={type:'tool_result',tool_use_id:block.id,content,is_error:denied}
  console.log(JSON.stringify({type:'user',message:{content:[result]},tool_use_result:{stdout:content,interrupted:false},
    tool_result_meta:[{id:block.id,permission_decision:{decision:denied?'reject':'accept',source:denied?'hook':'config'}}]}))
  messages.push({role:'user',content:[result]})
  await request()
 }
 request().catch(e=>{console.error(e.message);process.exitCode=1})
} else {
 const prompt = args.at(-1), skill = /^[/$]/.test(prompt) ? prompt.slice(1) : undefined
 const file = skill ? path.resolve(claude ? '.claude/skills' : '.agents/skills',skill,'SKILL.md') : path.resolve('AGENTS.md')
 const bytes = fs.readFileSync(file,'utf8'), broken = bytes.includes('Cockpit selftest replacement control')
 if (!process.env.HOME.includes('/.cockpit/local/probes/')) throw new Error('model probe inherited owner HOME')
 if (claude && skill && broken) console.log(JSON.stringify({type:'result',result:'This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "'+skill+'" skill for you.'}))
 else {
  let text
  if (skill && claude) text='Base directory for this skill: '+path.dirname(file)+'\\n\\n'+bytes.replace(/^---\\n[\\s\\S]*?\\n---\\n/,'')
  else if (skill && !broken) text='<skill>\\n<name>'+skill+'</name>\\n<path>'+file+'</path>\\n'+bytes+'\\n</skill>'
  else if (skill) { text=prompt; console.error('failed to load skill '+file+': missing YAML frontmatter delimited by ---') }
  else {
   if (!fs.readFileSync('CLAUDE.md','utf8').includes('@AGENTS.md')) throw new Error('generated Claude import missing')
   const content=bytes.replace(/^<!--[^\\n]*-->\\n(?:[ \\t]*\\n)*/gm,'').trim()
   text='<system-reminder>\\nContents of '+file+' (project instructions, checked into the codebase):\\n\\n'+content+'\\n</system-reminder>'
  }
  const payload=claude ? {messages:[{role:'user',content:[{type:'text',text}]}]} : {input:[{type:'message',role:'user',content:[{type:'input_text',text}]}]}
  if(claude) {
   const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'))
   const ancestor=path.resolve(process.cwd().split('/.cockpit/')[0],'CLAUDE.local.md')
   if(!settings.claudeMdExcludes?.includes(ancestor)) payload.messages.push({role:'user',content:[{type:'text',text:fs.readFileSync(ancestor,'utf8')}]})
  }
  const endpoint=claude ? process.env.ANTHROPIC_BASE_URL : JSON.parse(args.find(a=>a.startsWith('model_providers.cockpit_selftest.base_url=')).split('=').slice(1).join('='))
  fetch(endpoint+(claude?'/v1/messages':'/responses'),{method:'POST',body:JSON.stringify(payload)}).then(async r=>{await r.text();if(!r.ok)throw new Error('model capture refused');console.log(JSON.stringify({type:'result',result:'synthetic completed'}))}).catch(e=>{console.error(e.message);process.exitCode=1})
 }
}
`

async function nativeHarnesses(root: string): Promise<string> {
    const bin = join(root, 'native-bin')
    await mkdir(bin)
    for (const name of ['claude', 'codex']) {
        await writeFile(join(bin, name), NATIVE_HARNESS)
        await chmod(join(bin, name), 0o700)
    }
    return bin
}

// A team keeps its own PreToolUse hooks beside cockpit's guard in the same settings file.
const TEAM_SETTINGS = `${JSON.stringify({ hooks: {
    PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/team-bash-guard.sh' }] },
        { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/team-path-guard.sh' }] },
    ],
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/team-format.sh' }] }],
} }, null, 2)}\n`

describe('native model input selftest', () => {
    it('measures source-bound Claude instructions and both skill bodies and paired guard events without claiming skill review acceptance', async () => {
        const { issuedApplication } = createSelftestFixture(roots)
        const { root, application } = await issuedApplication()
        const bin = await nativeHarnesses(root)
        const ancestorCanary = 'SYNTHETIC_ANCESTOR_MEMORY_MUST_STAY_LOCAL'
        await writeFile(join(root, 'CLAUDE.local.md'), ancestorCanary)
        const draft = draftSurfaceSelftestSpecifications(application.surfaceSelftest)!
        expect(draft.specifications.find(row => row.harness.target === 'claudecode' && row.capability === 'guard-firing')?.protocol)
            .toBe('claude-guard-loopback/v1')
        expect(draft.specifications.find(row => row.harness.target === 'claudecode' && row.capability === 'instruction-loading')?.protocol)
            .toBe('claude-model-input/v1')
        const identities = { 'Claude Code': [join(bin, 'claude')], Codex: [join(bin, 'codex')] }
        const outcome = await runSurfaceSelftestApplication({ root, application, specifications: draft.specifications,
            env: { PATH: bin, HOME: '/synthetic-owner-home' } }, { execute: executeProbe, testOnlyExecutableIdentities: identities })
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'complete' })
        if (outcome.kind !== 'complete') throw new Error('native input measurement failed')
        expect(outcome.evidence.errors).toEqual([])
        const supported = draft.specifications.filter(row => row.protocol !== 'native-unsupported/v1')
        expect(outcome.evidence.evidence).toHaveLength(supported.length)
        expect(outcome.evidence.pending.every(row => row.harness.kind === 'builtin' && (row.harness.target === 'opencode' || row.harness.target === 'codexcli' && row.capability === 'guard-firing'))).toBe(true)
        expect(outcome.evidence.skillReviews.every(row => row.status === 'human_needed')).toBe(true)
        expect(JSON.stringify(outcome.bundle)).not.toContain(ancestorCanary)
        for (const record of outcome.evidence.evidence.filter(row => row.capability === 'skill-parity')) {
            expect(record.sample?.features).toEqual(['body-load'])
            expect(record.verdict).toBe('instructed')
            const generated = application.surfaceSelftest.entries.find(entry => entry.path.endsWith(`/skills/${record.sample!.skill}/SKILL.md`)
                && entry.harnesses.includes(record.harness.kind === 'builtin' ? record.harness.target : 'codexcli'))!
            expect(generated.kind).toBe('file')
            if (generated.kind === 'file') expect(await readFile(join(root, record.candidatePath), 'utf8')).toBe(generated.bytes)
        }
        const guard = outcome.evidence.evidence.find(row => row.capability === 'guard-firing')!
        expect(guard).toMatchObject({ verdict: 'enforced', protocol: 'claude-guard-loopback/v1',
            events: { candidateControl: { result: 'refused', exitCode: 0 }, brokenControl: { result: 'allowed', exitCode: 0 } } })
        for (const invalid of [
            { ...guard, guardProbe: { ...guard.guardProbe!, host: 'different.example.test' } },
            { ...guard, guardProbe: { ...guard.guardProbe!, receipts: { candidate: [], broken: [] } } },
            { ...guard, candidateSha256: 'e'.repeat(64) },
            { ...guard, modelEndpoints: { candidate: 'http://127.0.0.1:99999/' + 'a'.repeat(48), broken: guard.modelEndpoints!.broken } },
        ]) {
            const validation = validateSelftestEvidenceBundle({ ...outcome.bundle, records: outcome.bundle.records.map(row => row.kind === 'evidence' && row.runId === guard.runId ? invalid : row) },
                surfaceSelftestExpectation(application.surfaceSelftest)!, root, { testOnlyExecutableIdentities: identities })
            expect(validation.errors.length).toBeGreaterThan(0)
        }
        const guardPath = join(root, '.cockpit/guards/bash-guard.sh')
        const originalGuard = await readFile(guardPath, 'utf8')
        try {
            const drifted = await runSurfaceSelftestApplication({ root, application, specifications: draft.specifications,
                env: { PATH: bin, HOME: '/synthetic-owner-home' } }, {
                testOnlyExecutableIdentities: identities,
                execute: async step => {
                    if (step.labels.capability === 'guard-firing' && step.labels.role === 'candidate') {
                        await writeFile(guardPath, '#!/bin/sh\nexit 0\n')
                    }
                    return executeProbe(step)
                },
            })
            expect(drifted).toMatchObject({ kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID',
                reason: expect.stringContaining(`the candidate step was refused with EXECUTION_PRECONDITION_CHANGED: the generated Bash guard ${guardPath} changed after this run bound it`) })
        } finally { await writeFile(guardPath, originalGuard) }
        const forged = structuredClone(outcome.bundle)
        const record = forged.records.find(row => row.kind === 'evidence' && row.capability === 'skill-parity')!
        if (record.kind !== 'evidence') throw new Error('skill evidence missing')
        record.candidateSha256 = 'f'.repeat(64)
        expect(validateSelftestEvidenceBundle(forged, surfaceSelftestExpectation(application.surfaceSelftest)!, root,
            { testOnlyExecutableIdentities: identities }).errors).toEqual(expect.arrayContaining([
            expect.stringContaining('generated skill source authority'),
        ]))
        for (const malformed of [
            { ...record, events: { ...record.events, brokenControl: { ...record.events.brokenControl, stderr: null } } },
            { ...record, modelInputs: { candidate: null, broken: '[]' } },
        ]) {
            const check = () => validateSelftestEvidenceBundle({ ...outcome.bundle,
                records: outcome.bundle.records.map(row => row.kind === 'evidence' && row.runId === record.runId ? malformed : row) },
                surfaceSelftestExpectation(application.surfaceSelftest)!, root, { testOnlyExecutableIdentities: identities })
            expect(check).not.toThrow()
            expect(check().errors.length).toBeGreaterThan(0)
        }
    }, 180_000)

    it('breaks only cockpit\'s guard hook in the broken control, keeps the team\'s hooks running in both, and names a team hook that blocks the probe', async () => {
        const { issuedApplication } = createSelftestFixture(roots)
        const { root, configPath } = await issuedApplication()
        await mkdir(join(root, 'cockpit/adopted/.claude'), { recursive: true })
        await writeFile(join(root, 'cockpit/adopted/.claude/settings.json'), TEAM_SETTINGS)
        await writeFile(configPath, `${await readFile(configPath, 'utf8')}
[[surfaces.adopted]]
path = ".claude/settings.json"
source = "cockpit/adopted/.claude/settings.json"
sha256 = "${sha256Hex(TEAM_SETTINGS)}"
adopted_on = "2026-01-01"
provenance = { source = ".claude/settings.json", kind = "declared", reason = "Keep the team's own hooks", observed_on = "2026-01-01" }
`)
        const synced = await syncGeneratedEnvironment({ configPath })
        if (synced.kind !== 'complete') throw new Error(JSON.stringify(synced.diagnostics))
        const application = synced.result.application
        const hookLog = join(root, 'team-hook.log')
        const teamHook = join(root, '.claude/hooks/team-bash-guard.sh')
        await mkdir(dirname(teamHook), { recursive: true })
        // Shell builtins only: the probe's PATH holds nothing but the tool under test.
        await writeFile(teamHook, `#!/bin/sh\nread -r payload\nprintf '%s\\n' "$payload" >> '${hookLog}'\n`)
        await chmod(teamHook, 0o700)
        const bin = await nativeHarnesses(root)
        const specifications = draftSurfaceSelftestSpecifications(application.surfaceSelftest)!.specifications
        const selftest = () => runSurfaceSelftestApplication({ root, application, specifications, env: { PATH: bin, HOME: '/synthetic-owner-home' } },
            { execute: executeProbe, testOnlyExecutableIdentities: { 'Claude Code': [join(bin, 'claude')], Codex: [join(bin, 'codex')] } })

        const outcome = await selftest()
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'complete' })
        if (outcome.kind !== 'complete') throw new Error('guard measurement beside team hooks failed')
        expect(outcome.evidence.errors).toEqual([])
        const guard = outcome.evidence.evidence.find(row => row.capability === 'guard-firing')!
        expect(guard).toMatchObject({ verdict: 'enforced', protocol: 'claude-guard-loopback/v1' })
        const candidate = await readFile(join(root, guard.candidatePath), 'utf8')
        const cockpitHook = JSON.stringify((JSON.parse(candidate).hooks.PreToolUse as { hooks: { command: string }[] }[])
            .flatMap(group => group.hooks).find(hook => hook.command.includes('.cockpit/guards/bash-guard.sh'))!.command)
        expect(candidate.split(cockpitHook)).toHaveLength(2)
        expect(await readFile(join(root, guard.brokenPath), 'utf8')).toBe(candidate.replace(cockpitHook, JSON.stringify(guard.guardProbe!.brokenCommand)))
        // The team's Bash hook saw both probe commands under each control.
        expect((await readFile(hookLog, 'utf8')).trim().split('\n')).toHaveLength(4)

        // Every cell selftest can measure was measured; unsupported cells and skill reviews are reported beside that.
        const artifactPath = join(root, 'probe-specifications.json')
        const quiet = { stdout: { write: () => true }, stderr: { write: () => true } }
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], quiet)).toBe(0)
        const measured = await runConfiguredSurfaceSelftestOutcome({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin, HOME: '/synthetic-owner-home' },
            requestProbeSpecificationsApproval: async candidate => candidate.sha256, requestExecutableApproval: async candidate => candidate.sha256 })
        expect(measured.status, JSON.stringify(measured.diagnostics)).toBe(0)
        expect(measured.result).toMatchObject({ summary: { measurementComplete: true, pendingSkillReviews: expect.any(Number) } })
        const summaryText = renderHumanDiagnostics([], { command: 'selftest', outcome: measured })
        expect(summaryText).toMatch(/^Selftest measured every cell it can: \d+ measured, \d+ pending\./)
        expect(summaryText).toContain('cockpit cannot perform or record these reviews')
        expect(summaryText).not.toMatch(/record the five|Maintainer: complete/)

        await writeFile(teamHook, '#!/bin/sh\necho "Team policy refuses this command." >&2\nexit 2\n')
        const stdin = Object.assign(new PassThrough(), { isTTY: true })
        const shown: string[] = []
        const stderr = Object.assign(new Writable({ write: (bytes, _encoding, done) => {
            shown.push(String(bytes))
            if (String(bytes).includes('[yes/no]')) setImmediate(() => stdin.write('yes\n'))
            done()
        } }), { isTTY: true })
        const blocked = await runSelftestOperatorCommand({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin, HOME: '/synthetic-owner-home' } },
            { interactive: true, json: false, ci: undefined }, { stdin: stdin as unknown as NodeJS.ReadStream, stderr }, runConfiguredSurfaceSelftestOutcome)
        stdin.destroy()

        // Before approving, the person sees each team hook the guard probe's settings register, and none of cockpit's own.
        const review = shown.join('').split('[yes/no]')[0]!
        expect(review).toContain('PreToolUse matcher "Bash" runs $CLAUDE_PROJECT_DIR/.claude/hooks/team-bash-guard.sh')
        expect(review).toContain('PreToolUse matcher "Edit|Write|MultiEdit" runs $CLAUDE_PROJECT_DIR/.claude/hooks/team-path-guard.sh')
        expect(review).toContain('PostToolUse matcher "Edit|Write" runs $CLAUDE_PROJECT_DIR/.claude/hooks/team-format.sh')
        expect(review).not.toContain('.cockpit/guards/bash-guard.sh')
        expect(review).not.toContain('SessionStart')

        // The blocked guard cell fails with its reason while every other cell is still measured.
        expect(blocked.status, JSON.stringify(blocked.diagnostics)).toBe(2)
        const terminal = renderHumanDiagnostics([], { command: 'selftest', outcome: blocked })
        expect(terminal).toMatch(/^FAILED Claude Code guard-firing: a PreToolUse hook beside cockpit's guard refused a probe command/)
        expect(terminal).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/team-bash-guard.sh')
        expect(terminal).toContain('Team policy refuses this command.')
        expect(terminal).not.toContain('team-path-guard.sh')
        expect(terminal).not.toMatch(/\bremove\b/i)
        expect(blocked.diagnostics[0]).toMatchObject({ severity: 'error', code: 'SELFTEST_EXECUTION_INVALID', target: 'probe_failed' })
        const result = blocked.result as { reportPath: string; summary: Record<string, unknown>
            evidence: { errors: string[]; evidence: { capability: string; harness: { name: string } }[] } }
        const supported = specifications.filter(row => row.protocol !== 'native-unsupported/v1').length
        expect(result.summary).toMatchObject({ measuredCells: supported - 1, measurementComplete: false,
            failedCells: [{ cell: 'Claude Code guard-firing', failure: expect.stringContaining('Team policy refuses this command.') }] })
        expect(result.evidence.errors).toEqual([])
        expect(result.evidence.evidence.some(row => row.capability === 'guard-firing' && row.harness.name === 'Claude Code')).toBe(false)
        expect(JSON.parse(await readFile(result.reportPath, 'utf8')).result).toEqual(result)
    }, 180_000)

    it('measures Claude instruction loading through a team CLAUDE.md that imports AGENTS.md once, with or without notes, and says why one importing more is not measured', async () => {
        const { issuedApplication } = createSelftestFixture(roots)
        const claudeInstructions = <T extends { harness: { kind: string; target?: string }; capability: string }>(records: readonly T[]) =>
            records.find(row => row.harness.target === 'claudecode' && row.capability === 'instruction-loading')
        const measure = async (claudeGuide: string, teamAgents?: string) => {
            const { root, application } = await issuedApplication({ 'CLAUDE.md': claudeGuide, ...teamAgents === undefined ? {} : { 'AGENTS.md': teamAgents } })
            // The team's file already imports AGENTS.md, so cockpit leaves it as written and owns no CLAUDE.md.
            expect(application.surfaceSelftest.entries.some(entry => entry.path === 'CLAUDE.md')).toBe(false)
            expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toBe(claudeGuide)
            const bin = await nativeHarnesses(root)
            return runSurfaceSelftestApplication({ root, application, specifications: draftSurfaceSelftestSpecifications(application.surfaceSelftest)!.specifications,
                env: { PATH: bin, HOME: '/synthetic-owner-home' } }, { execute: executeProbe, testOnlyExecutableIdentities: { 'Claude Code': [join(bin, 'claude')], Codex: [join(bin, 'codex')] } })
        }

        const importOnly = await measure('@AGENTS.md\n')
        expect(importOnly, JSON.stringify(importOnly)).toMatchObject({ kind: 'complete' })
        if (importOnly.kind !== 'complete') throw new Error('import-only team guide was not measured')
        expect(importOnly.evidence.errors).toEqual([])
        expect(claudeInstructions(importOnly.evidence.evidence)).toMatchObject({ verdict: 'instructed', protocol: 'claude-model-input/v1' })

        const withNotes = await measure('@AGENTS.md\n\nUse the Bash tool for git; ask @oncall before a release.\n')
        expect(withNotes, JSON.stringify(withNotes)).toMatchObject({ kind: 'complete' })
        if (withNotes.kind !== 'complete') throw new Error('team guide with notes was not measured')
        expect(withNotes.evidence.errors).toEqual([])
        expect(claudeInstructions(withNotes.evidence.evidence)).toMatchObject({ verdict: 'instructed', protocol: 'claude-model-input/v1' })

        const withImport = await measure('@AGENTS.md\n\nAlso read @~/claude-notes.md before editing.\n')
        expect(withImport, JSON.stringify(withImport)).toMatchObject({ kind: 'complete' })
        if (withImport.kind !== 'complete') throw new Error('team guide with another import stopped the run')
        expect(claudeInstructions(withImport.evidence.evidence)).toBeUndefined()
        const pending = claudeInstructions(withImport.evidence.pending)
        expect(pending).toMatchObject({ reason: 'native_protocol_unsupported',
            operatorAction: expect.stringContaining('also imports @~/claude-notes.md') })
        expect(pending!.operatorAction).not.toMatch(/run sync, then rerun selftest|run sync to restore/)

        // The tool loads the root AGENTS.md whole, so an import in the team's part of it is named too.
        const agentsImport = await measure('@AGENTS.md\n', '# Team guide\n\nRead @../shared/team.md before editing.\n')
        if (agentsImport.kind !== 'complete') throw new Error('team AGENTS.md with an import stopped the run')
        expect(claudeInstructions(agentsImport.evidence.pending)).toMatchObject({ reason: 'native_protocol_unsupported',
            operatorAction: expect.stringContaining('The root AGENTS.md imports @../shared/team.md') })

        // A package name or a handle in prose resolves to no file, so nothing is imported and the cell is measured.
        const packageProse = await measure('@AGENTS.md\n\nAsk @jane.doe before a release.\n', '# Team guide\n\nUse @acme/ui for components and @types/node for types.\n')
        if (packageProse.kind !== 'complete') throw new Error('team guide naming packages stopped the run')
        expect(packageProse.evidence.errors).toEqual([])
        expect(claudeInstructions(packageProse.evidence.evidence)).toMatchObject({ verdict: 'instructed' })
    }, 180_000)

    it('says every supported cell was measured only when it was, and measures Claude instructions beside a one-line team comment', async () => {
        const quiet = { stdout: { write: () => true }, stderr: { write: () => true } }
        const configured = async (teamAgents: string) => {
            const { root, configPath } = await createSelftestFixture(roots).issuedApplication({ 'AGENTS.md': teamAgents })
            const bin = await nativeHarnesses(root)
            const artifactPath = join(root, 'probe-specifications.json')
            expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], quiet)).toBe(0)
            const outcome = await runConfiguredSurfaceSelftestOutcome({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin, HOME: '/synthetic-owner-home' },
                requestProbeSpecificationsApproval: async candidate => candidate.sha256, requestExecutableApproval: async candidate => candidate.sha256 })
            const result = outcome.result as { summary: { measurementComplete: boolean }; evidence: { evidence: { harness: { name: string }; capability: string }[] } }
            return { outcome, summary: result.summary,
                claudeMeasured: result.evidence.evidence.some(row => row.harness.name === 'Claude Code' && row.capability === 'instruction-loading') }
        }
        // Claude removes a standalone one-line comment before delivering the guide, as it does cockpit's markers.
        const lineComment = await configured('<!-- markdownlint-disable MD013 -->\n# Team guide\n\nKeep changes small.\n')
        expect(lineComment.claudeMeasured).toBe(true)
        expect(lineComment.summary.measurementComplete).toBe(true)
        // A comment spanning lines is not reproduced by the probe, so that supported cell stays unmeasured and the run says so.
        const blockComment = await configured('# Team guide\n\n<!--\nReviewed every quarter.\n-->\n\nKeep changes small.\n')
        expect(blockComment.claudeMeasured).toBe(false)
        expect(blockComment.summary.measurementComplete).toBe(false)
        expect(renderHumanDiagnostics([], { command: 'selftest', outcome: blockComment.outcome })).toMatch(/^Selftest incomplete:/)
    }, 300_000)

    it('tells the operator to declare a vendor host when none is declared, and says plainly that Codex guard firing is not measured', async () => {
        const { root, configPath } = await createSelftestFixture(roots).issuedApplication()
        await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('vendor_endpoint_hosts = [ "api.vendor.example.test" ]', 'vendor_endpoint_hosts = []'))
        const synced = await syncGeneratedEnvironment({ configPath })
        if (synced.kind !== 'complete') throw new Error(JSON.stringify(synced.diagnostics))
        const application = synced.result.application
        const bin = await nativeHarnesses(root)
        const outcome = await runSurfaceSelftestApplication({ root, application, specifications: draftSurfaceSelftestSpecifications(application.surfaceSelftest)!.specifications,
            env: { PATH: bin, HOME: '/synthetic-owner-home' } }, { execute: executeProbe, testOnlyExecutableIdentities: { 'Claude Code': [join(bin, 'claude')], Codex: [join(bin, 'codex')] } })
        if (outcome.kind !== 'complete') throw new Error(JSON.stringify(outcome))
        expect(outcome.evidence.errors).toEqual([])
        const guardCell = (target: string) => outcome.evidence.pending.find(row => row.capability === 'guard-firing' && row.harness.kind === 'builtin' && row.harness.target === target)
        expect(guardCell('claudecode')).toMatchObject({ reason: 'guard_host_undeclared', operatorAction: expect.stringContaining('[guards] vendor_endpoint_hosts') })
        expect(guardCell('codexcli')).toMatchObject({ reason: 'native_protocol_unsupported', operatorAction: expect.stringContaining('cannot measure Codex guard firing') })
        expect(guardCell('codexcli')!.operatorAction).not.toContain('Claude')
    }, 180_000)

    it('refuses before asking for any approval when sync ran under a different Node, naming both and both ways forward', async () => {
        const { root, configPath } = await createSelftestFixture(roots).issuedApplication()
        // A Node version manager gives the shell that ran sync one Node and the shell running selftest another.
        const syncNode = join(root, 'other-node/bin/node')
        await mkdir(dirname(syncNode), { recursive: true })
        await copyFile(process.execPath, syncNode, constants.COPYFILE_FICLONE)
        const launcher = fileURLToPath(new URL('../../bin/cockpit.mjs', import.meta.url))
        const synced = spawnSync(syncNode, [launcher, 'sync', '--config', configPath], { cwd: root, encoding: 'utf8' })
        expect(synced.status, synced.stderr).toBe(0)
        const bin = await nativeHarnesses(root)
        const artifactPath = join(root, 'probe-specifications.json')
        const quiet = { stdout: { write: () => true }, stderr: { write: () => true } }
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], quiet)).toBe(0)
        const approvals: string[] = []
        const outcome = await runSelftestOperatorCommand({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin, HOME: '/synthetic-owner-home' } },
            { interactive: true, json: false, ci: undefined }, { stderr: quiet.stderr,
                confirmSelftestProbeSpecifications: async candidate => { approvals.push(candidate.canonicalPath); return candidate.sha256 },
                confirmSelftestExecutable: async candidate => { approvals.push(candidate.canonicalPath); return candidate.sha256 } },
            runConfiguredSurfaceSelftestOutcome)

        expect(approvals).toEqual([])
        expect(outcome.status).toBe(2)
        const selftestNode = await realpath(process.execPath)
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ severity: 'error', code: 'SELFTEST_GUARD_IDENTITY_MISMATCH',
            message: expect.stringContaining(`sync installed the guard for the Node at ${syncNode}, but this selftest runs under the Node at ${selftestNode}`) })])
        const { fix } = outcome.diagnostics[0]!
        expect(fix).toContain(`${syncNode} ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config ${configPath} --interactive --probe-specifications ${artifactPath}`)
        expect(fix).toContain(`./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${configPath}`)
    }, 180_000)

    it('names a Node changed in place since sync and gives only the remedy that can work', async () => {
        const { root, configPath } = await createSelftestFixture(roots).issuedApplication()
        // The Node at the recorded path was replaced by other bytes after sync, as an in-place upgrade does.
        const identityPath = join(root, '.cockpit/local/guard-identity')
        const installed = parseGuardLocalIdentity(await readFile(identityPath, 'utf8'))!
        await writeFile(identityPath, encodeGuardLocalIdentity({ ...installed, nodeSha256: 'f'.repeat(64) }))
        const bin = await nativeHarnesses(root)
        const artifactPath = join(root, 'probe-specifications.json')
        const quiet = { stdout: { write: () => true }, stderr: { write: () => true } }
        expect(await runCli(['selftest', '--config', configPath, '--write-probe-specifications', artifactPath], quiet)).toBe(0)
        const approvals: string[] = []
        const outcome = await runSelftestOperatorCommand({ configPath, probeSpecificationsPath: artifactPath, env: { PATH: bin, HOME: '/synthetic-owner-home' } },
            { interactive: true, json: false, ci: undefined }, { stderr: quiet.stderr,
                confirmSelftestProbeSpecifications: async candidate => { approvals.push(candidate.canonicalPath); return candidate.sha256 },
                confirmSelftestExecutable: async candidate => { approvals.push(candidate.canonicalPath); return candidate.sha256 } },
            runConfiguredSurfaceSelftestOutcome)
        expect(approvals).toEqual([])
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'SELFTEST_GUARD_IDENTITY_MISMATCH',
            message: expect.stringContaining(`the Node at ${installed.node} changed since sync recorded it`) })])
        const { fix } = outcome.diagnostics[0]!
        expect(fix).toContain(`./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ${configPath}`)
        expect(fix).not.toContain(`${installed.node} ./node_modules`)
    }, 180_000)

    it('records a cell whose measurement fails with its reason and still measures the other tools', async () => {
        const { root, application } = await createSelftestFixture(roots).issuedApplication()
        const bin = await nativeHarnesses(root)
        await writeFile(join(bin, 'claude'), NATIVE_HARNESS.replace('0.0.0-synthetic (Claude Code)', 'unversioned build'))
        const outcome = await runSurfaceSelftestApplication({ root, application, specifications: draftSurfaceSelftestSpecifications(application.surfaceSelftest)!.specifications,
            env: { PATH: bin, HOME: '/synthetic-owner-home' } }, { execute: executeProbe, testOnlyExecutableIdentities: { 'Claude Code': [join(bin, 'claude')], Codex: [join(bin, 'codex')] } })
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'incomplete', status: 2 })
        if (outcome.kind !== 'incomplete') throw new Error('a failed cell stopped the run')
        expect(outcome.evidence.errors).toEqual([])
        const failed = outcome.evidence.pending.filter(row => row.reason === 'probe_failed')
        expect(failed.length).toBeGreaterThan(0)
        expect(failed.every(row => row.harness.kind === 'builtin' && row.harness.target === 'claudecode'
            && /^Claude Code --version printed no version cockpit recognises/.test(row.operatorAction))).toBe(true)
        expect(outcome.evidence.evidence.filter(row => row.harness.kind === 'builtin' && row.harness.target === 'claudecode')).toEqual([])
        expect(outcome.evidence.evidence.some(row => row.harness.kind === 'builtin' && row.harness.target === 'codexcli')).toBe(true)
    }, 180_000)
})
