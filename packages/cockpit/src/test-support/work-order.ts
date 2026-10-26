export function workOrderFixture(options: { criteria?: number; status?: string; programme?: string } = {}): string {
    const count = options.criteria ?? 3
    return `---
id: WO-001
title: Repair the cache boundary
status: ${options.status ?? 'draft'}
created: 2026-01-02
${options.programme === undefined ? '' : `programme: ${options.programme}\n`}---
## Objective
Return current values after a cache refresh.
## Non-goals
Changing the storage provider.
## Context and sources
- S1 | read | src/cache.ts | Current implementation inspected.
- S2 | inferred | tests/cache.test.ts | Regression shape inferred from the defect.
- S3 | operator-confirmed | issue:cache-refresh | Requested behavior confirmed.
## Authority
- src/cache.ts
- tests/cache.test.ts
## Acceptance criteria
${Array.from({ length: count }, (_, index) => `### AC${index + 1}
Source: S${index % 3 + 1}
Given: A previously cached value exists.
When: Refresh ${index + 1} completes.
Then: Reading the cache returns the refreshed value.`).join('\n')}
## Verification
${Array.from({ length: count }, (_, index) => `- AC${index + 1} | ["npm","test","--","cache-${index + 1}"]`).join('\n')}
## Docs impact
none: Internal behavior preserves the documented interface.
## Plan
1. [ ] Reproduce the stale value through the cache interface.
2. [ ] Correct the cache update and run verification.
## Evidence
- none
## Decisions
- 2026-01-02 | Preserve the cache interface | accepted | Existing callers depend on it | No caller migration.
`
}

export function padWorkOrder(text: string, bytes: number): string {
    const remaining = bytes - Buffer.byteLength(text)
    if (remaining < 0) throw new Error('padding target is smaller than the fixture')
    const chunks: string[] = [text]
    let left = remaining
    while (left > 0) {
        const size = Math.min(left, 1_024)
        chunks.push(' '.repeat(size - 1), '\n')
        left -= size
    }
    return chunks.join('')
}
