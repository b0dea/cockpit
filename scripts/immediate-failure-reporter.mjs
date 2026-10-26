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
}
