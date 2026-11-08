import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import { executeProbe } from '../environment-exec/execute.js'
import { runSurfaceSelftestApplication } from '../environment/selftest-application.js'
import { syncGeneratedEnvironment } from '../generated-environment/command.js'
import { sha256Hex } from '../sha256.js'
import { draftSurfaceSelftestSpecifications, surfaceSelftestExpectation } from '../surfaces/selftest.js'
import { validateSelftestEvidenceBundle } from '../../libexec/validate-harness-evidence.mjs'

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
   const content=bytes.replace(/^<!-- cockpit:[^\\n]*-->\\n(?:[ \\t]*\\n)*/gm,'').trim()
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
                reason: expect.stringContaining('EXECUTION_PRECONDITION_CHANGED') })
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

        await writeFile(teamHook, '#!/bin/sh\necho "Team policy refuses this command." >&2\nexit 2\n')
        const blocked = await selftest()
        expect(blocked).toMatchObject({ kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID', reason: expect.stringContaining('beside cockpit\'s guard') })
        if (blocked.kind !== 'refusal') throw new Error('a blocking team hook was not reported')
        expect(blocked.reason).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/team-bash-guard.sh')
        expect(blocked.reason).toContain('Team policy refuses this command.')
        expect(blocked.reason).not.toContain('team-path-guard.sh')
        expect(blocked.reason).not.toMatch(/\bremove\b/i)
    }, 180_000)

    it('names the step that failed instead of refusing without a reason', async () => {
        const { root, application } = await createSelftestFixture(roots).issuedApplication()
        const bin = await nativeHarnesses(root)
        await writeFile(join(bin, 'claude'), NATIVE_HARNESS.replace('0.0.0-synthetic (Claude Code)', 'unversioned build'))
        const outcome = await runSurfaceSelftestApplication({ root, application, specifications: draftSurfaceSelftestSpecifications(application.surfaceSelftest)!.specifications,
            env: { PATH: bin, HOME: '/synthetic-owner-home' } }, { execute: executeProbe, testOnlyExecutableIdentities: { 'Claude Code': [join(bin, 'claude')], Codex: [join(bin, 'codex')] } })
        expect(outcome).toMatchObject({ kind: 'refusal', code: 'SELFTEST_EXECUTION_INVALID',
            reason: expect.stringMatching(/^probe execution could not establish [a-z-]+ for Claude Code: Claude Code --version printed/) })
    }, 180_000)
})
