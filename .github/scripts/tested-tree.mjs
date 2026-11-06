// Says which checks have not passed on one exact tree, so a push to main, a version-only pull request
// and the release gate run or wait for only those. Usage: tested-tree.mjs <commit> <tree>
// [group...]. The groups are `linux` and `platforms`, the test cells, which are the default, and
// `ci-ok`, the required check. Prints one missing group per line, or `none`. Every caller treats a
// failed lookup or no output as everything missing, so nothing can pass by failing to say anything.
//
// A cell's job name carries the tree it checked out, and the tree in the name is what must match.
// ci-ok's name carries no tree, so it counts only from a run whose head commit has this tree.
//
// Runs from a copy taken from the base revision, like the other change guards, so it must stay
// self-contained.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const CELLS = {
    linux: ['1/4', '2/4', '3/4', '4/4'].map(shard => `ubuntu-latest, node 22.22.0, full ${shard}`),
    platforms: ['macos-latest, node 22.22.0, full', 'ubuntu-latest, node 24, compatibility', 'ubuntu-latest, node 26, compatibility'],
}
const CELL_JOB = /^test \((?<cell>.+)\) tree (?<tree>[0-9a-f]{40})$/

// Job names are whatever the workflow file of that run says, and anyone who can push a branch can
// run an edited ci.yml: through a pull request into a scratch base, or a push trigger added on their
// branch. Only the default branch's own pushes run a workflow that passed review.
// No pull request run counts: GitHub drops a closed pull request from both the run and the commit's
// pull request list, so which base a run merged with cannot be proven after the fact.
function qualifies(run, repository, defaultBranch) {
    return run.path === '.github/workflows/ci.yml' && run.conclusion === 'success' && run.head_repository?.full_name === repository
        && run.event === 'push' && run.head_branch === defaultBranch
}

function missingGroups(runs, tree, repository, defaultBranch, groups) {
    const passed = new Set()
    for (const run of runs) {
        if (!qualifies(run, repository, defaultBranch)) continue
        for (const job of run.jobs) {
            if (job.conclusion !== 'success') continue
            const match = CELL_JOB.exec(job.name)
            if (match?.groups.tree === tree) passed.add(match.groups.cell)
            if (job.name === 'ci-ok' && run.head_commit?.tree_id === tree) passed.add('ci-ok')
        }
    }
    return groups.filter(group => group === 'ci-ok' ? !passed.has('ci-ok') : !CELLS[group].every(cell => passed.has(cell)))
}

const [commit, tree, ...requested] = process.argv.slice(2)
const groups = requested.length > 0 ? requested : Object.keys(CELLS)
const repository = process.env.GITHUB_REPOSITORY
if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !/^[0-9a-f]{40}$/.test(tree ?? '') || !repository
    || !groups.every(group => group === 'ci-ok' || Object.hasOwn(CELLS, group))) {
    throw new Error('usage: tested-tree.mjs <commit> <tree> [linux|platforms|ci-ok ...], with GITHUB_REPOSITORY set')
}
// Any failed lookup rejects, so the script exits non-zero and prints nothing.
const api = async path => {
    const { stdout, stderr } = await promisify(execFile)('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    process.stderr.write(stderr)
    return JSON.parse(stdout)
}
const defaultBranch = (await api(`repos/${repository}`)).default_branch
if (typeof defaultBranch !== 'string' || defaultBranch === '') throw new Error(`repos/${repository} reported no default branch`)
const runs = (await api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&status=success&per_page=100`)).workflow_runs
const withJobs = await Promise.all(runs.map(async run => ({ ...run, jobs: (await api(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`)).jobs })))
const missing = missingGroups(withJobs, tree, repository, defaultBranch, groups)
console.log(missing.length === 0 ? 'none' : missing.join('\n'))
