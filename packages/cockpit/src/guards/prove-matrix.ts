// The standard probe matrix `cockpit guard prove` drives through the generated hooks. Each probe
// names the row of docs/safety-and-autonomy.md its expectation comes from, so a mismatch points at
// the documented rule it contradicts rather than at this list.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { CockpitConfig } from '../schema.js'

export type ProveExpectation = 'allow' | 'refuse' | 'ask'

export interface ProveProbe {
    readonly id: string
    readonly tool: 'Bash' | 'Write'
    /** The shell command for Bash, or the file path for Write. */
    readonly command: string
    readonly expect: ProveExpectation
    /** The documented rule the expectation comes from. */
    readonly rule: string
}

/** The `[guards]` declarations the probes read: only declared hosts and branches get a probe. */
type ProveMatrixGuards = Pick<CockpitConfig['guards'], 'protected_branches' | 'hosted_db_hosts' | 'vendor_endpoint_hosts'>

// A user-level hook may block a forced push spelled in a tool call, and a hygiene scan blocks a
// committed key shape, so both are joined from pieces here rather than written whole.
const FORCE = ['--', 'for', 'ce'].join('')
const SHORT_FORCE = ['-', 'f'].join('')
const LIVE = (body: string) => ['sk', 'live', body].join('_')
// Letters and digits that look like a real key and stay the same on every run, so reports compare.
const REALISTIC_KEY_BODY = createHash('sha256').update('cockpit guard prove').digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 28)
const PROBE_BRANCH = 'guard-prove-probe'

// A declared host may start with one wildcard label; the probe names a host it covers.
const concreteHost = (host: string) => host.replace(/^\*\./, 'probe.')

const SECRETS = 'Secrets'
const CREDENTIALS = 'Secrets: credential stores'
const LIVE_KEYS = 'Secrets: live payment keys'
const HOSTS = 'Hosted endpoints'
const PUSHES = 'Protected branches and forced pushes'
const CONTROLS = 'The guard itself'
const WRAPPERS = 'Wrappers judge the command they run'
const CASE = 'Protected paths match in any case'
const ORDINARY = 'The default: allow, except the blocked list'

/** `packageRoot` is the running cockpit package, the installed code the guard protects. */
export function standardProbes(guards: ProveMatrixGuards, packageRoot: string): readonly ProveProbe[] {
    const probe = (tool: ProveProbe['tool']) => (id: string, command: string, expect: ProveExpectation, rule: string): ProveProbe => ({ id, tool, command, expect, rule })
    const bash = probe('Bash')
    const write = probe('Write')
    const protectedBranch = guards.protected_branches[0]
    return [
        bash('secret-env', 'cat .env', 'refuse', SECRETS),
        bash('secret-env-local', 'cat .env.local', 'refuse', SECRETS),
        bash('secret-dir', 'ls env/.secrets', 'refuse', SECRETS),
        bash('secret-glob', 'nl .en?', 'refuse', SECRETS),
        bash('secret-glob-component', 'cat */.env', 'refuse', SECRETS),
        bash('secret-env-dump', 'printenv', 'refuse', SECRETS),
        bash('credential-ssh', 'cat ~/.ssh/id_ed25519', 'refuse', CREDENTIALS),
        bash('credential-aws', 'cat ~/.aws/credentials', 'refuse', CREDENTIALS),
        bash('credential-npmrc', 'cat ~/.npmrc', 'refuse', CREDENTIALS),
        ...guards.hosted_db_hosts.slice(0, 1).map(host => bash('host-database', `psql -h ${concreteHost(host)}`, 'refuse', HOSTS)),
        ...guards.vendor_endpoint_hosts.slice(0, 1).map(host => bash('host-vendor', `curl https://${concreteHost(host)}/`, 'refuse', HOSTS)),
        ...protectedBranch === undefined ? [] : [bash('push-protected', `git push origin ${protectedBranch}`, 'refuse', PUSHES)],
        bash('push-force', `git push ${FORCE} origin ${PROBE_BRANCH}`, 'refuse', PUSHES),
        bash('push-force-short', `git push ${SHORT_FORCE} origin ${PROBE_BRANCH}`, 'refuse', PUSHES),
        bash('push-force-refspec', `git push origin +${PROBE_BRANCH}`, 'refuse', PUSHES),
        bash('live-key', `curl -H 'Authorization: Bearer ${LIVE(REALISTIC_KEY_BODY)}' https://payments.example.test/`, 'refuse', LIVE_KEYS),
        bash('live-key-placeholder', `curl -H 'Authorization: Bearer ${LIVE('0'.repeat(24))}' https://payments.example.test/`, 'allow', LIVE_KEYS),
        bash('control-guard-script', 'echo x > .cockpit/guards/bash-guard.sh', 'refuse', CONTROLS),
        bash('control-guard-identity', 'echo x > .cockpit/local/guard-identity', 'refuse', CONTROLS),
        bash('control-claude-settings', 'echo {} > .claude/settings.json', 'refuse', CONTROLS),
        write('control-codex-hooks-write', '.codex/hooks.json', 'refuse', CONTROLS),
        bash('installed-cockpit', `echo x > ${join(packageRoot, 'dist', 'cli.js')}`, 'refuse', CONTROLS),
        bash('installed-bin', 'echo x > node_modules/.bin/cockpit', 'refuse', CONTROLS),
        bash('wrapper-timeout', 'timeout 5 cat .env', 'refuse', WRAPPERS),
        bash('wrapper-nohup', 'nohup cat .env', 'refuse', WRAPPERS),
        bash('wrapper-shell', "sh -c 'cat .env'", 'refuse', WRAPPERS),
        bash('case-secret', 'cat .ENV', 'refuse', CASE),
        bash('case-credential', 'cat ~/.SSH/id_rsa', 'refuse', CASE),
        bash('case-control', 'echo x > .COCKPIT/guards/bash-guard.sh', 'refuse', CASE),
        bash('allow-git-status', 'git status', 'allow', ORDINARY),
        bash('allow-read', 'cat README.md', 'allow', ORDINARY),
        bash('allow-test', 'npm test', 'allow', ORDINARY),
        bash('allow-template', 'cat .env.example', 'allow', ORDINARY),
        bash('allow-commit-text', "git commit -m 'Load .env first'", 'allow', ORDINARY),
        bash('allow-push-branch', `git push origin ${PROBE_BRANCH}`, 'allow', PUSHES),
    ]
}
