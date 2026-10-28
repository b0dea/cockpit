import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { CockpitConfig } from '../src/schema.js'
import { syncGeneratedEnvironment } from '../src/generated-environment/command.js'
import { createConfiguredWorkApplicationComposition } from '../src/work-orders/composition.js'
import { parseWorkOrder, type ParsedWorkOrder } from '../src/work-orders/contract.js'
import type { WorkOrderIdentityGit } from '../src/work-orders/identity-observation.js'
import { workOrderFixture } from '../src/test-support/work-order.js'

const nativeFixture = `#!/usr/bin/env node
const fs = require('node:fs'); const crypto = require('node:crypto')
const argv = process.argv.slice(2); const output = argv[argv.indexOf('--output-last-message') + 1]
if (argv.length === 1 && argv[0] === '--version') { process.stdout.write('codex-cli 0.149.0\\n'); process.exit(0) }
if (argv.length === 2 && argv[0] === 'exec' && argv[1] === '--help') {
  process.stdout.write('--ephemeral --ignore-user-config --sandbox --cd --json --output-schema --output-last-message\\n'); process.exit(0)
}
const match = /request JSON at (.+) with SHA-256 ([a-f0-9]{64});/.exec(argv.at(-1))
if (!match) process.exit(31)
const bytes = fs.readFileSync(match[1]); if (crypto.createHash('sha256').update(bytes).digest('hex') !== match[2]) process.exit(32)
const request = JSON.parse(bytes); const context = request.context; let response
if (fs.existsSync('.native-expect-artifact')) {
  const expected = fs.readFileSync('.native-expect-artifact', 'utf8')
  const artifacts = request.role === 'grader' ? context.artifacts : context.subject?.artifacts
  if (!Array.isArray(artifacts) || !artifacts.some(row => row.text.includes(expected))) process.exit(35)
}
if (request.role === 'grader') {
  if (!request.instruction.includes('Return exactly one outcome per criterion') || Object.hasOwn(request, 'evaluator')) process.exit(33)
} else if (Object.hasOwn(request, 'evaluator') || request.instruction.includes('You grade a work-order')
  || !request.instruction.includes('affectedVerification') || !request.instruction.includes(request.role)
  || !context.subject || !Array.isArray(context.changedPaths)) process.exit(34)
fs.appendFileSync('.native-calls', request.role + '\\n')
const mode = fs.existsSync('.native-mode') ? fs.readFileSync('.native-mode', 'utf8').trim() : 'complete'
if (request.role === 'grader') response = { kind: 'assessment', runId: context.runId, integrity: 'clean', criteria: context.criteria.map(row => {
  const artifact = context.artifacts[0]; const verification = context.verification.filter(item => item.criterion === row.criterion.id)
  return { criterion: row.criterion.id, criterionDigest: row.digest, outcome: 'passed with current supporting evidence',
    verificationDigests: verification.map(item => item.digest), verificationEvidence: verification.map(item => ({ digest: item.digest, stream: 'stdout', start: 0, end: 6, quote: 'passed' })),
    evidence: [{ path: artifact.path, digest: artifact.digest, start: 0, end: artifact.text.length, quote: artifact.text, symbol: 'refresh' }],
    observation: 'Current evidence supports the criterion.', alternative: 'External providers remain outside this evidence.' }
}) }
else { const findingId = request.role + '-advisory'; response = { kind: 'review', runId: context.runId, contractDigest: context.subject.contractDigest, artifactDigest: context.subject.artifactDigest,
  findings: [{ id: findingId, severity: 'advisory', summary: request.role + ' retained a documented tradeoff', affectedVerification: [context.subject.verification[0].argv] }],
  dispositions: [{ findingId, outcome: 'accepted-risk', reason: 'The synthetic boundary records the exact disposition.' }], evidence: request.role + ' accepted current evidence' } }
if (mode === 'extra') response.extra = true
fs.writeFileSync(output, JSON.stringify(response), { flag: 'wx', mode: 0o600 })
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: mode === 'replay' ? 'fixed-thread' : crypto.randomUUID() }) + '\\n')
`

export function createWorkCompositionFixtureSupport(roots: string[]) {
async function configuredFixture(options: Readonly<{ rootSibling?: boolean; externalSibling?: boolean; authority?: readonly string[]; hardlinkedGit?: boolean }> = {}) {
    const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-work-application-'))); roots.push(fixtureRoot)
    const root = options.externalSibling ? join(fixtureRoot, 'cockpit') : fixtureRoot
    if (options.externalSibling) await mkdir(root)
    const applicationRoot = options.externalSibling ? join(fixtureRoot, 'app') : join(root, 'app')
    const tools = join(root, 'tools'); const workorders = join(root, 'workorders')
    await Promise.all([mkdir(tools), mkdir(join(workorders, 'programmes'), { recursive: true }), mkdir(applicationRoot), mkdir(join(root, 'fixtures')),
        mkdir(join(root, '.cockpit/actors'), { recursive: true }), mkdir(join(root, 'src')), mkdir(join(root, 'tests')), mkdir(join(root, 'skills')), mkdir(join(root, 'intents')), mkdir(join(root, 'candidates'))])
    const configPath = join(root, 'cockpit.toml')
    const rootSibling = options.rootSibling ? `
[[sibling]]
slug = "root"
dir = "."
mount = "none"
acquire = "none"
var = "ROOT_DIR"
purpose = "Synthetic root declaration"
` : ''
    let declaration = (await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')).replace(
        'name = "generated-environment"', `name = "generated-environment"\nsiblings_root = "${options.externalSibling ? '..' : '.'}"`,
    ) + rootSibling + '\n[testing]\nstages = [{ id = "unit", command = ["npm", "test", "--", "cache-1"], requires_stack = false }, { id = "stack", command = ["npm", "test", "--", "stack"], requires_stack = true }]\ngates = [{ id = "focused", tier = "targeted", stages = ["unit"], changes = "Isolated behavior" }, { id = "stacked", tier = "targeted", stages = ["stack"], changes = "Runtime behavior" }]\nnative_hooks = { install = "inspect" }\n'
    if (options.externalSibling) {
        const external = CockpitConfig.parse(parseToml(declaration))
        external.environment.generated!.vendors = []
        external.environment.generated!.decisions.entries = external.environment.generated!.decisions.entries
            .filter(entry => entry.subject !== 'vendor')
        declaration = stringifyToml(CockpitConfig.parse(external))
    }
    await writeFile(configPath, declaration)
    await writeFile(join(root, '.gitignore'), '.native-calls\n.native-mode\n.native-expect-artifact\n.verification-overflow\n.gate-mutate\n.completion-observations\n.completion-artifact-race\n.execution-hold\n.execution-started\n.identity-inventory-unavailable\n.identity-inventory-malformed\n.identity-worktree-malformed\n.identity-inventory-change\n.identity-inventory-count\n.repository-status-malformed\n')
    await writeFile(join(root, 'fixtures/personas.json'), '[{"id":"first"}]\n')
    await writeFile(join(applicationRoot, 'package-lock.json'), '{}\n')
    await mkdir(join(applicationRoot, 'src'))
    await writeFile(join(applicationRoot, 'src/external.ts'), "export const external = 'authenticated sibling artifact'\n")
    await writeFile(join(root, 'src/cache.ts'), "export function refresh() { return 'fresh' }\n")
    await writeFile(join(root, 'tests/cache.test.ts'), "export const proof = 'fresh'\n")
    const skillBytes = Buffer.from('Use the inspected source to plan the smallest current change.\n')
    await writeFile(join(root, 'skills/planning.md'), skillBytes)
    await writeFile(join(tools, 'git'), `#!/bin/sh
case "$1" in
  for-each-ref)
    if [ -e .identity-inventory-unavailable ] || [ -e .identity-inventory-malformed ] || [ -e .identity-inventory-change ]; then
      exec "\${0%/*}/node" "$0-faults.cjs" "$@"
    fi
    ;;
  worktree)
    if [ "$2" = list ] && [ -e .identity-worktree-malformed ]; then
      exec "\${0%/*}/node" "$0-faults.cjs" "$@"
    fi
    ;;
  status)
    for argument in "$@"; do
      if [ "$argument" = --branch ] && [ -e .repository-status-malformed ]; then
        exec "\${0%/*}/node" "$0-faults.cjs" "$@"
      fi
      if [ "$argument" = --porcelain=v2 ] && [ -e .completion-artifact-race ]; then
        exec "\${0%/*}/node" "$0-faults.cjs" "$@"
      fi
    done
    ;;
esac
exec /usr/bin/git "$@"
`)
    await writeFile(join(tools, 'git-faults.cjs'), `
const fs = require('node:fs'); const { spawnSync } = require('node:child_process')
const argv = process.argv.slice(2)
if (argv[0] === 'for-each-ref' && fs.existsSync('.identity-inventory-unavailable')) process.exit(63)
if (argv[0] === 'for-each-ref' && fs.existsSync('.identity-inventory-malformed')) { process.stdout.write('not-an-object\\n'); process.exit(0) }
if (argv[0] === 'worktree' && argv[1] === 'list' && fs.existsSync('.identity-worktree-malformed')) {
  const head = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.status !== 0) process.exit(head.status ?? 1)
  process.stdout.write('worktree ' + process.cwd() + '\\0HEAD ' + head.stdout.trim() + '\\0detached\\0locked\\0prunable\\0\\0'); process.exit(0)
}
if (argv[0] === 'for-each-ref' && fs.existsSync('.identity-inventory-change')) {
  const count = fs.existsSync('.identity-inventory-count') ? Number(fs.readFileSync('.identity-inventory-count', 'utf8')) + 1 : 1
  fs.writeFileSync('.identity-inventory-count', String(count))
  if (count === 2) { const changed = spawnSync('/usr/bin/git', ['branch', 'synthetic-inventory-change'], { stdio: 'inherit' }); if (changed.status !== 0) process.exit(changed.status ?? 1) }
}
if (argv[0] === 'status' && argv.includes('--branch') && fs.existsSync('.repository-status-malformed')) {
  const result = spawnSync('/usr/bin/git', argv, { encoding: 'utf8' })
  if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status ?? 1) }
  process.stdout.write(result.stdout.replace(/# branch\\.oid [a-f0-9]+\\0/, '# branch.oid ' + 'a'.repeat(41) + '\\0')); process.exit(0)
}
if (fs.existsSync('.completion-artifact-race') && argv[0] === 'status' && argv.includes('--porcelain=v2')) {
  const current = JSON.parse(fs.readFileSync('.cockpit/work-orders/WO-003/current.json', 'utf8'))
  if (Object.hasOwn(current.files, 'grade.json')) {
    const count = fs.existsSync('.completion-observations') ? Number(fs.readFileSync('.completion-observations', 'utf8')) + 1 : 1
    fs.writeFileSync('.completion-observations', String(count))
    if (count === 2) { fs.writeFileSync('src/cache.ts', "export function refresh() { return 'changed-at-completion' }\\n"); fs.unlinkSync('.completion-artifact-race') }
  }
}
const result = spawnSync('/usr/bin/git', argv, { stdio: 'inherit' }); process.exit(result.status ?? 1)
`)
    await writeFile(join(tools, 'npm'), "#!/bin/sh\nif [ -f .verification-overflow ]; then /usr/bin/yes x | /usr/bin/head -c 70000; exit 0; fi\nif [ -f .gate-mutate ]; then printf \"export function refresh() { return 'changed' }\\n\" > src/cache.ts; fi\nif [ -f .execution-hold ]; then : > .execution-started; while [ -f .execution-hold ]; do sleep 0.05; done; fi\nprintf 'passed\\n'\n")
    await writeFile(join(tools, 'codex'), nativeFixture)
    await symlink(process.execPath, join(tools, 'node'))
    await Promise.all(['git', 'npm', 'codex'].map(name => chmod(join(tools, name), 0o700)))
    const authority = options.authority ?? ['src/cache.ts', 'tests/cache.test.ts']
    const firstBytes = workOrderFixture().replace('- src/cache.ts\n- tests/cache.test.ts', authority.map(path => `- ${path}`).join('\n'))
    const secondBytes = firstBytes.replaceAll('WO-001', 'WO-002')
    const thirdBytes = firstBytes.replaceAll('WO-001', 'WO-003')
    const audit = (contract: ParsedWorkOrder) => JSON.stringify({ sources: contract.sources, gaps: [], skills: {
        status: 'audited', auditor: 'fixture-auditor', provenance: 'operator-confirmed', rows: [{ reference: 'cache-planning', scope: 'repository',
            category: 'planning', applicable: true, reason: 'The current task needs source-grounded planning', sourceIds: ['S1'], path: 'skills/planning.md',
            sha256: createHash('sha256').update(skillBytes).digest('hex') }],
    } })
    for (const [id, bytes] of [['WO-001', firstBytes], ['WO-002', secondBytes], ['WO-003', thirdBytes]] as const) {
        const parsed = parseWorkOrder(Buffer.from(bytes)); if (!parsed.ok) throw new Error(`${id} contract fixture refused`)
        await writeFile(join(workorders, `${id}.md`), bytes)
        await writeFile(join(workorders, `${id}.source-audit.json`), audit(parsed.value))
    }
    await writeFile(join(root, 'fixtures/intent.md'), 'Upstream intent requires a durable cache repair.\n')
    await writeFile(join(root, 'intents/fix.json'), JSON.stringify({ version: 1, kind: 'task', reference: 'fixtures/intent.md', certification: false, crossSession: false, programme: null }))
    await writeFile(join(root, 'intents/work.json'), JSON.stringify({ version: 1, kind: 'task', reference: 'fixtures/intent.md', certification: false, crossSession: true, programme: null }))
    const intentCandidate = workOrderFixture().replaceAll('WO-001', 'WO-004')
        .replace('issue:cache-refresh', 'fixtures/intent.md').replace('- tests/cache.test.ts\n## Acceptance', '- tests/cache.test.ts\n- fixtures/intent.md\n## Acceptance')
    const intentParsed = parseWorkOrder(Buffer.from(intentCandidate)); if (!intentParsed.ok) throw new Error('intent candidate fixture refused')
    const secondIntentCandidate = intentCandidate.replaceAll('WO-004', 'WO-006')
    const secondIntentParsed = parseWorkOrder(Buffer.from(secondIntentCandidate)); if (!secondIntentParsed.ok) throw new Error('second intent candidate fixture refused')
    await Promise.all([
        writeFile(join(root, 'candidates/WO-004.md'), intentCandidate), writeFile(join(root, 'candidates/WO-004.source-audit.json'), audit(intentParsed.value)),
        writeFile(join(root, 'candidates/WO-006.md'), secondIntentCandidate), writeFile(join(root, 'candidates/WO-006.source-audit.json'), audit(secondIntentParsed.value)),
    ])
    const programmeCandidate = workOrderFixture({ programme: 'cache' }).replaceAll('WO-001', 'WO-005')
    const programmeParsed = parseWorkOrder(Buffer.from(programmeCandidate)); if (!programmeParsed.ok) throw new Error('programme candidate fixture refused')
    const secondProgrammeCandidate = workOrderFixture({ programme: 'queue' }).replaceAll('WO-001', 'WO-007')
    const secondProgrammeParsed = parseWorkOrder(Buffer.from(secondProgrammeCandidate)); if (!secondProgrammeParsed.ok) throw new Error('second programme candidate fixture refused')
    await Promise.all([writeFile(join(root, 'candidates/WO-005.md'), programmeCandidate), writeFile(join(root, 'candidates/WO-005.source-audit.json'), audit(programmeParsed.value)),
        writeFile(join(root, 'candidates/WO-007.md'), secondProgrammeCandidate), writeFile(join(root, 'candidates/WO-007.source-audit.json'), audit(secondProgrammeParsed.value)),
        writeFile(join(workorders, 'programmes/cache.json'), JSON.stringify({ programme: 'cache', items: [{ key: 'repair', objective: 'Repair cache behavior', independentlyShippable: true, orderId: null, orderDigest: null }] })),
        writeFile(join(workorders, 'programmes/queue.json'), JSON.stringify({ programme: 'queue', items: [{ key: 'drain', objective: 'Repair queue behavior', independentlyShippable: true, orderId: null, orderDigest: null }] })),
        writeFile(join(root, 'intents/heartbeat.json'), JSON.stringify({ kind: 'heartbeat' })),
        writeFile(join(root, 'intents/forged-runtime-evidence.json'), JSON.stringify({ kind: 'evidence', layer: 'runtime', reference: 'src/cache.ts' })),
        writeFile(join(root, 'intents/source-evidence.json'), JSON.stringify({ kind: 'evidence', layer: 'source', reference: 'src/cache.ts' }))])
    const gitEnvironment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
    for (const argv of [['init', '--quiet'], ['add', '.'], ['commit', '--quiet', '-m', 'synthetic fixture']] as const) {
        const result = spawnSync('/usr/bin/git', argv, { cwd: root, env: gitEnvironment, encoding: 'utf8' })
        if (result.status !== 0) throw new Error(`fixture git ${argv[0]} failed: ${result.stderr}`)
    }
    if (options.externalSibling) for (const argv of [['init', '--quiet'], ['add', '.'], ['commit', '--quiet', '-m', 'synthetic sibling fixture']] as const) {
        const result = spawnSync('/usr/bin/git', argv, { cwd: applicationRoot, env: gitEnvironment, encoding: 'utf8' })
        if (result.status !== 0) throw new Error(`sibling fixture git ${argv[0]} failed: ${result.stderr}`)
    }
    const synced = await syncGeneratedEnvironment({ configPath })
    if (synced.kind !== 'complete') throw new Error(`generated fixture sync refused: ${JSON.stringify(synced.diagnostics)}`)
    let hardlinkedGitAlias: string | undefined
    if (options.hardlinkedGit) {
        const aliases = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-work-tool-links-'))); roots.push(aliases)
        hardlinkedGitAlias = join(aliases, 'git')
        await link(join(tools, 'git'), hardlinkedGitAlias)
    }
    await writeFile(join(applicationRoot, '.env.example'), 'SYNTHETIC=true\n')
    const environment = Object.freeze({ ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` })
    const configured = await createConfiguredWorkApplicationComposition({ configPath, env: environment })
    if (configured.kind !== 'complete') throw new Error(configured.reason)
    return { root, applicationRoot, configPath, environment, composition: configured.composition, secondBytes, hardlinkedGitAlias }
}

return { configuredFixture }
}

export async function reidentifyWorkOrder(root: string, from: string, to: string): Promise<void> {
    const directory = join(root, 'workorders')
    const bytes = (await readFile(join(directory, `${from}.md`), 'utf8')).replaceAll(from, to)
    const audit = await readFile(join(directory, `${from}.source-audit.json`))
    await Promise.all([writeFile(join(directory, `${to}.md`), bytes), writeFile(join(directory, `${to}.source-audit.json`), audit)])
    await Promise.all([rm(join(directory, `${from}.md`)), rm(join(directory, `${from}.source-audit.json`))])
}

export const executedGit = (stdout: string) => ({
    kind: 'executed' as const, exitCode: 0, stdout, stderr: '', truncated: false,
})

export function gitWithObjectId(objectId: string, location: 'ref' | 'worktree'): WorkOrderIdentityGit {
    return async (cwd, argv) => {
        if (argv[0] === 'rev-parse') return executedGit('/synthetic/.git\n')
        if (argv[0] === 'for-each-ref') return executedGit(location === 'ref' ? `${objectId} refs/heads/main\n` : '')
        if (argv[0] === 'worktree') return executedGit(`worktree ${cwd}\0HEAD ${objectId}\0detached\0\0`)
        if (argv[0] === 'ls-tree' || argv[0] === 'ls-files' || argv[0] === 'status') return executedGit('')
        throw new Error(`unexpected Git invocation: ${argv.join(' ')}`)
    }
}

export async function waitForChildLine(owner: ReturnType<typeof spawn>, expected: string, timeoutMs = 5_000): Promise<void> {
    if (!owner.stdout) throw new Error('lock owner stdout was not captured')
    const stdout = owner.stdout
    await new Promise<void>((resolveReady, rejectReady) => {
        let output = ''
        const cleanup = () => {
            clearTimeout(timeout)
            owner.off('error', onError)
            owner.off('exit', onExit)
            stdout.off('data', onData)
        }
        const settle = (error?: Error) => {
            cleanup()
            if (error) rejectReady(error)
            else resolveReady()
        }
        const onError = (error: Error) => settle(error)
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            settle(new Error(`lock owner exited before readiness (code=${String(code)}, signal=${String(signal)})`))
        const onData = (bytes: Buffer) => {
            output += bytes.toString('utf8')
            if (output.split('\n').includes(expected)) settle()
        }
        const timeout = setTimeout(() => settle(new Error(`lock owner did not emit ${JSON.stringify(expected)} within ${timeoutMs}ms`)), timeoutMs)
        owner.once('error', onError)
        owner.once('exit', onExit)
        stdout.on('data', onData)
        if (owner.exitCode !== null || owner.signalCode !== null) onExit(owner.exitCode, owner.signalCode)
    })
}

export async function stopChild(owner: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<void> {
    if (owner.exitCode !== null || owner.signalCode !== null) return
    await new Promise<void>((resolveExit, rejectExit) => {
        const cleanup = () => {
            clearTimeout(timeout)
            owner.off('error', onError)
            owner.off('close', onClose)
        }
        const settle = (error?: Error) => {
            cleanup()
            if (error) rejectExit(error)
            else resolveExit()
        }
        const onError = (error: Error) => settle(error)
        const onClose = () => settle()
        const timeout = setTimeout(() => settle(new Error(`lock owner did not close within ${timeoutMs}ms`)), timeoutMs)
        owner.once('error', onError)
        owner.once('close', onClose)
        if (owner.exitCode !== null || owner.signalCode !== null) settle()
        else if (!owner.kill('SIGKILL')) settle(new Error('lock owner could not be stopped'))
    })
}
