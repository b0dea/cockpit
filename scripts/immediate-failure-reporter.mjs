import { appendFileSync } from 'node:fs'

export const mechanism = {
    id: 'immediate-test-failures', module: 'scripts/immediate-failure-reporter.mjs', exports: ['default'],
}

export default class ImmediateFailureReporter {
    logger

    onInit(context) {
        this.logger = context.logger
    }

    onTestCaseResult(testCase) {
        const result = testCase.result()
        if (result.state !== 'failed') return
        this.logger.error(`\n FAIL ${testCase.module.relativeModuleId} > ${testCase.fullName}`)
        for (const error of result.errors) this.logger.printError(error, { project: testCase.project })
    }

    // The JSON report is written only when the run ends on its own, so a run cut off by the
    // deadline would otherwise leave nothing recording which files finished, or which ones were
    // still running when it was stopped. Appending per module keeps that record on disk as the
    // run progresses.
    onTestModuleStart(testModule) {
        record(testModule.moduleId, 'started')
    }

    onTestModuleEnd(testModule) {
        record(testModule.moduleId, testModule.state() === 'passed' && testModule.ok() ? 'passed' : 'failed')
    }
}

function record(file, state) {
    const path = process.env.COCKPIT_TEST_PROGRESS_FILE
    if (path) appendFileSync(path, `${JSON.stringify({ file, state, at: Date.now() })}\n`)
}
