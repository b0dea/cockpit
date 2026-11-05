// Says which test cells have not passed on one exact tree, so the push to main and the Version
// Packages pull request run only those. Usage: tested-tree.mjs <commit> <tree>. Prints one missing
// group per line, or `none`. The workflow runs every cell on a failed lookup or on no output, so
// nothing can pass by failing to say anything.
//
// A pull request run tests the merge of its head with the base of that moment, which can differ from
// the head and from what lands on main. So a cell's job name carries the tree it checked out, and a
// run's commit only says where to look; the tree in the name is what must match.
//
// Runs from a copy taken from the base revision, like the other change guards, so it must stay
// self-contained.
import { execFileSync } from 'node:child_process'

const CELLS = {
    linux: ['1/4', '2/4', '3/4', '4/4'].map(shard => `ubuntu-latest, node 22.22.0, full ${shard}`),
    platforms: ['macos-latest, node 22.22.0, full', 'ubuntu-latest, node 24, compatibility', 'ubuntu-latest, node 26, compatibility'],
}
const CELL_JOB = /^test \((?<cell>.+)\) tree (?<tree>[0-9a-f]{40})$/

function missingGroups(runs, tree, repository) {
    const passed = new Set()
    for (const run of runs) {
        // A fork's run executes the fork's workflow, so its job names prove nothing here.
        if (run.path !== '.github/workflows/ci.yml' || run.conclusion !== 'success' || run.head_repository?.full_name !== repository) continue
        for (const job of run.jobs) {
            const match = CELL_JOB.exec(job.name)
            if (match?.groups.tree === tree && job.conclusion === 'success') passed.add(match.groups.cell)
        }
    }
    return Object.entries(CELLS).filter(([, cells]) => !cells.every(cell => passed.has(cell))).map(([group]) => group)
}

const [commit, tree] = process.argv.slice(2)
const repository = process.env.GITHUB_REPOSITORY
if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !/^[0-9a-f]{40}$/.test(tree ?? '') || !repository) {
    throw new Error('usage: tested-tree.mjs <commit> <tree>, with GITHUB_REPOSITORY set')
}
const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }))
const heads = api(`repos/${repository}/commits/${commit}/pulls`).map(pull => pull.head.sha)
const runs = [...new Set([commit, ...heads])].flatMap(sha => api(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`).workflow_runs)
const withJobs = runs.map(run => ({ ...run, jobs: api(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).jobs }))
const missing = missingGroups(withJobs, tree, repository)
console.log(missing.length === 0 ? 'none' : missing.join('\n'))
