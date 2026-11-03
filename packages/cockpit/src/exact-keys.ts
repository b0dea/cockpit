/** True when `value` has every `required` own enumerable key and no key outside `required` and `optional`. */
export function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
    const keys = Object.keys(value)
    return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}

/**
 * The same check over every own key, enumerable or not, refusing symbol keys and accessors. Envelopes a
 * caller hands back are checked this way, so that reading them later invokes nothing the caller planted.
 */
export function exactOwnKeys(value: object, required: readonly string[]): boolean {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    return keys.every((key) => typeof key === 'string' && 'value' in descriptors[key]! && required.includes(key))
        && required.every((key) => keys.includes(key))
}
