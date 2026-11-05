import { describe, expect, it } from 'vitest'
import { withStatus } from './decision-record.js'
import { inspectDecisionRecords } from './decisions.js'

const inspect = (files: Record<string, string>, index?: string) => inspectDecisionRecords({
    repository: '', directory: 'docs/adr', files: new Map(Object.entries(files)),
    ...index === undefined ? {} : { index: { path: 'docs/adr/README.md', body: index } },
}).map(row => `${row.code} ${row.message}`)

describe('decision record integrity', () => {
    // Two branches each took the next free number, two records landed without an index line, and
    // an index line outlived the record it linked.
    it('reports reused numbers, records the index omits and index links to records that do not exist', () => {
        expect(inspect({
            'README.md': '',
            '0001-store.md': '# Store\n\nStatus: Accepted\n',
            '0002-cache.md': '# Cache\n\nStatus: Accepted\n',
            '0002-queue.md': '# Queue\n\nStatus: Accepted\n',
            '0003-retry.md': '# Retry\n\nStatus: Proposed\n',
            '0000-template.md': '# Title\n\nStatus: <one of the statuses>\n',
        }, '# Decisions\n\n- [Store](0001-store.md)\n- [Cache](./0002-cache.md#context)\n- [Lost](0004-lost.md)\n- [Elsewhere](../guide.md)\n')).toEqual([
            'DECISION_NUMBER_REUSED decision records docs/adr/0002-cache.md and docs/adr/0002-queue.md share number 2',
            'DECISION_INDEX_ENTRY_MISSING decision index docs/adr/README.md:5 links 0004-lost.md, which does not exist',
            'DECISION_UNINDEXED decision record docs/adr/0002-queue.md is not linked from docs/adr/README.md',
            'DECISION_UNINDEXED decision record docs/adr/0003-retry.md is not linked from docs/adr/README.md',
        ])
        // Dated names carry no number to reuse, and a date in a supersedes line is a file name, not a number.
        expect(inspect({ '2026-09-store.md': 'Status: Superseded by 2026-09-cache.md\n',
            '2026-09-cache.md': 'Status: Accepted\n\nSupersedes 2026-09-store.md.\n' }, '[Store](2026-09-store.md) [Cache](2026-09-cache.md) [Budget](100%-budget.md)\n'))
            .toEqual(['DECISION_INDEX_ENTRY_MISSING decision index docs/adr/README.md:1 links 100%-budget.md, which does not exist'])
    })

    it('reads a status from front matter, a Status line or a Status heading, and reports one missing or unknown', () => {
        expect(inspect({
            '0001-a.md': '---\nstatus: accepted\n---\n# A\n',
            '0002-b.md': '# B\n\n**Status:** Deprecated\n',
            '0003-c.md': '# C\n\n## Status\n\nRejected (2026-01-02)\n',
            '0004-d.md': '# D\n\nNo status here.\n',
            '0005-e.md': '# E\n\nStatus: Draft\n',
        })).toEqual([
            'DECISION_STATUS_MISSING decision record docs/adr/0004-d.md states no status',
            'DECISION_STATUS_MISSING decision record docs/adr/0005-e.md has status "Draft", which starts with none of proposed, accepted, superseded, deprecated, rejected',
        ])
    })

    it('resolves every supersedes link, and reports a record superseded in full that still says accepted', () => {
        expect(inspect({
            '0001-store.md': '# Store\n\nStatus: Accepted\n',
            '0002-cache.md': '# Cache\n\nStatus: Superseded by [ADR 4](0004-cache-v2.md)\n',
            '0003-retry.md': '# Retry\n\nStatus: Accepted\n',
            '0004-cache-v2.md': '# Cache v2\n\nStatus: Accepted\n\nSupersedes ADR-0002 and supersedes 0001 (ADR-0001). Supersedes the backoff clause of 0003.\n',
            '0005-draft.md': '---\nstatus: proposed\nsupersedes: 3\n---\n# Draft\n',
            '0006-gone.md': '# Gone\n\nStatus: Superseded by #9, decided in 2027.\n',
        })).toEqual([
            'DECISION_SUPERSEDED_STALE decision record docs/adr/0001-store.md still has status "Accepted", but docs/adr/0004-cache-v2.md:5 supersedes it',
            'DECISION_LINK_UNRESOLVED decision record docs/adr/0006-gone.md:3 cites #9, which names no record in docs/adr',
        ])
    })

    it.each([
        'Supersedes decision 2 of [ADR 0013](0013-policy.md)',
        'Supersedes ADR 0013 only for retries. Other decisions stand.',
        'This supersedes 0013\'s "a clause". The rest stands.',
        'This supersedes the rule, stated in `docs/explanation/policy.md`',
        'Status: Accepted; supersedes [0013](0013-policy.md)\'s "a clause" and lines of `docs/explanation/policy.md`',
    ])('keeps accepted records current when only a clause is replaced: %s', reference => {
        expect(inspect({
            '0013-policy.md': 'Status: Accepted\n',
            '0018-update.md': `Status: Accepted\n\n${reference}\n`,
        })).toEqual([])
    })

    it('still resolves partial record references and checks whole-record replacements', () => {
        expect(inspect({
            '0013-policy.md': 'Status: Accepted\n',
            '0018-update.md': 'Status: Accepted\n\nSupersedes [Policy](0013-policy.md).\nSupersedes decision 2 of [Missing](0019-missing.md).\nSupersedes ADR 0020 only for retries.\nSupersedes [Missing](elsewhere/0021-missing.md).\nSupersedes [Missing](0022-missing.md)\'s retry clause.\nSupersedes the retry clause of [ADR 0023](elsewhere/0023-missing.md).\n',
        })).toEqual([
            'DECISION_SUPERSEDED_STALE decision record docs/adr/0013-policy.md still has status "Accepted", but docs/adr/0018-update.md:3 supersedes it',
            'DECISION_LINK_UNRESOLVED decision record docs/adr/0018-update.md:4 cites 0019-missing.md, which names no record in docs/adr',
            'DECISION_LINK_UNRESOLVED decision record docs/adr/0018-update.md:5 cites ADR 0020, which names no record in docs/adr',
            'DECISION_LINK_UNRESOLVED decision record docs/adr/0018-update.md:6 cites elsewhere/0021-missing.md, which names no record in docs/adr',
            'DECISION_LINK_UNRESOLVED decision record docs/adr/0018-update.md:7 cites 0022-missing.md, which names no record in docs/adr',
            'DECISION_LINK_UNRESOLVED decision record docs/adr/0018-update.md:8 cites elsewhere/0023-missing.md, which names no record in docs/adr',
        ])
    })

    // `work decide --supersedes` marks the old record with this; a status only the check could read
    // left the record unmarkable, and the check then reported it stale.
    it('marks a record superseded wherever the check reads its status, in the form it was written', () => {
        const newer = '# Cache v2\n\nStatus: Accepted\n\nSupersedes 0001.\n'
        for (const [old, marked] of [
            ['# Store\n\n- Status: Accepted\n', '# Store\n\n- Status: superseded by 0002\n'],
            ['# Store\n\n## Status\n\nAccepted\n\n## Context\n', '# Store\n\n## Status\n\nsuperseded by 0002\n\n## Context\n'],
            ['---\r\ntitle: Store\r\nstatus: accepted\r\n---\r\n# Store\r\n', '---\r\ntitle: Store\r\nstatus: superseded by 0002\r\n---\r\n# Store\r\n'],
            ['# Store\n\n```\nStatus: example\n```\n\n__Status__: Accepted\n', '# Store\n\n```\nStatus: example\n```\n\n__Status__: superseded by 0002\n'],
        ] as const) {
            expect(inspect({ '0001-store.md': old, '0002-cache-v2.md': newer })).toEqual([expect.stringMatching(/^DECISION_SUPERSEDED_STALE /)])
            expect(withStatus(old, 'superseded by 0002')).toBe(marked)
            expect(inspect({ '0001-store.md': marked, '0002-cache-v2.md': newer })).toEqual([])
        }
        expect(withStatus('# Store\n\nNo status here.\n', 'superseded by 0002')).toBeUndefined()
    })
})
