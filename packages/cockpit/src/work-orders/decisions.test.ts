import { describe, expect, it } from 'vitest'
import { nextRecordName } from './decisions.js'

describe('decision record names', () => {
    it('takes the next number at the width in use, or a free dated name where records are named by date', () => {
        expect(nextRecordName(['README.md', '00009-a.md', '0010-b.md'], 'Cache by tenant', '2026-11-04')).toEqual({ name: '00011-cache-by-tenant.md', number: '00011' })
        expect(nextRecordName([], 'Cache by tenant', '2026-11-04')).toEqual({ name: '0001-cache-by-tenant.md', number: '0001' })
        const dated = ['2026-09-14-keys.md', '2026-11-04-cache-by-tenant.md', '2026-11-04-cache-by-tenant-2.md']
        expect(nextRecordName(dated, 'Cache by tenant', '2026-11-04')).toEqual({ name: '2026-11-04-cache-by-tenant-3.md' })
    })
})
