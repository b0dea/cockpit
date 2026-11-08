import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createSelftestFixture } from '../../test-support/selftest-fixture.js'
import { executeProbe } from '../environment-exec/execute.js'
import { runSurfaceSelftestApplication } from '../environment/selftest-application.js'
import { draftSurfaceSelftestSpecifications, surfaceSelftestExpectation } from '../surfaces/selftest.js'
import { validateSelftestEvidenceBundle } from '../../libexec/validate-harness-evidence.mjs'

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

describe('native model input selftest', () => {
    it('measures source-bound Claude instructions and both skill bodies and paired guard events without claiming skill review acceptance', async () => {
        const { issuedApplication } = createSelftestFixture(roots)
        const { root, application } = await issuedApplication()
        const bin = join(root, 'native-bin')
        await mkdir(bin)
        const ancestorCanary = 'SYNTHETIC_ANCESTOR_MEMORY_MUST_STAY_LOCAL'
        await writeFile(join(root, 'CLAUDE.local.md'), ancestorCanary)
        const script = `#!${process.execPath}
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
 const hook=settings.hooks.PreToolUse[0].hooks[0].command
 const broken=hook.startsWith('cockpit-selftest-missing-hook-')
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
  const denied=!broken && block.id==='cockpit_forbidden'
  const decision={permissionDecision:'deny',permissionDecisionReason:'Refusing executable use of a declared vendor host.'}
  console.log(JSON.stringify({type:'system',subtype:'hook_response',hook_event:'PreToolUse',exit_code:broken?127:0,
    stdout:denied?JSON.stringify({hookSpecificOutput:decision}):'',stderr:broken?hook+': command not found':''}))
  let content=denied?'Denied by hook':'COCKPIT_GUARD_ORDINARY_'+nonce
  if(broken && block.id==='cockpit_forbidden') {
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
        for (const name of ['claude', 'codex']) {
            await writeFile(join(bin, name), script)
            await chmod(join(bin, name), 0o700)
        }
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
})
