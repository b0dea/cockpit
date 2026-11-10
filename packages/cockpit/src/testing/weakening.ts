// Owns which files a checkout treats as tests and how a finding is identified: the patterns a
// consumer declared under [testing] test_files or, failing that, the common layouts, plus the digest
// a person's acknowledgement binds to. The detection itself is test-protection.ts.
import { sha256Hex } from '../sha256.js'

import { scopeMatcher } from '../work-orders/contract.js'
import { classifyTestWeakening, type DiffFile, type TestRoles, type WeakeningFinding } from './test-protection.js'

const DEFAULT_TEST_FILES: readonly string[] = Object.freeze([
    '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/tests/**', '**/test/**', '**/e2e/**',
    '**/test_*.py', '**/*_test.py', '**/conftest.py', '**/*_test.go', '**/*Test.java', '**/*_spec.rb',
])
// What decides which tests run; a declared test_files list does not replace these.
const TEST_CONFIGURATION: readonly string[] = Object.freeze([
    '**/vitest.config.*', '**/vitest.workspace.*', '**/jest.config.*', '**/playwright.config.*', '**/.mocharc*',
    '**/pytest.ini', '**/tox.ini', '**/package.json',
])

export interface TestFilePatterns {
    readonly tests: readonly string[]
    readonly configuration: readonly string[]
    /** Where the test-file patterns came from, stated beside every finding. */
    readonly source: string
}

export function testFilePatterns(declared: readonly string[] | undefined): TestFilePatterns {
    return declared?.length
        ? { tests: declared, configuration: TEST_CONFIGURATION, source: '[testing] test_files in cockpit.toml' }
        : { tests: DEFAULT_TEST_FILES, configuration: TEST_CONFIGURATION, source: 'the built-in test-file patterns for common layouts (no [testing] test_files declared)' }
}

/** Whether the classifier can find anything in a change to `path`: it judges tests and test configuration only. */
export function judgedByWeakening(patterns: TestFilePatterns): (path: string) => boolean {
    const isTest = scopeMatcher(patterns.tests)
    const isTestConfig = scopeMatcher(patterns.configuration)
    return path => isTest(path) || isTestConfig(path)
}

export function weakeningFindings(files: readonly DiffFile[], patterns: TestFilePatterns): WeakeningFinding[] {
    const roles: TestRoles = { isTest: scopeMatcher(patterns.tests), isTestConfig: scopeMatcher(patterns.configuration) }
    return classifyTestWeakening(files, roles)
}

export interface RepositoryWeakening extends WeakeningFinding { readonly repository: string }

/** The digest an acknowledgement binds: exactly these findings, and no others, are acknowledged. */
export function testWeakeningDigest(findings: readonly RepositoryWeakening[]): string {
    const rows = findings.map(row => `${row.repository}\0${row.path}\0${row.kind}`).sort()
    return sha256Hex(JSON.stringify(rows))
}

export const describeWeakening = (row: RepositoryWeakening): string =>
    `${row.repository === '.' ? row.path : `${row.repository}:${row.path}`}: ${row.kind} (${row.reason})`
