import type { Acquire, Mount } from './schema.js'

/** Where a documented value came from. Anything not read directly carries a reason a person can confirm. */
export type Provenance = 'read' | 'inferred'

export interface Field<T> {
    value: T
    from: Provenance
    /** Why, when inferred. Printed next to the value; empty when read directly. */
    because?: string
}

export interface DocumentedSibling {
    slug: string
    dir: string
    remote?: string
    branch?: string
    mount: Field<Mount>
    acquire: Field<Acquire>
    var: string
    purpose: string
}

/** A field the schema requires that no source can supply. A human fills it once. */
export interface Gap {
    slug: string
    field: string
    why: string
    /** True when the schema refuses the config until this is answered. */
    blocking: boolean
    /** Action specific to the source of the gap, when the generic fix would mislead. */
    fix?: string
}
