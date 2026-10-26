import { isIP } from 'node:net'
import AjvDraft04Module from 'ajv-draft-04'
import type { AnySchema, ValidateFunction } from 'ajv-draft-04'

const emittedStringFormats: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
    date: (value: string) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
        if (!match) return false
        const year = Number(match[1])
        const month = Number(match[2])
        const day = Number(match[3])
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return month >= 1 && month <= 12 && day >= 1 && day <= monthDays[month - 1]!
    },
    uri: (value: string) => /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[A-Fa-f0-9]{2})*$/.test(value)
        && URL.canParse(value),
    ipv4: (value: string) => isIP(value) === 4,
    ipv6: (value: string) => isIP(value) === 6,
})

export function draft04Validator() {
    const validator = new AjvDraft04Module.default({ strict: false })
    for (const [name, validate] of Object.entries(emittedStringFormats)) {
        validator.addFormat(name, validate)
    }
    return validator
}

export function compileDraft04Schema(schema: AnySchema): ValidateFunction {
    return draft04Validator().compile(schema)
}
