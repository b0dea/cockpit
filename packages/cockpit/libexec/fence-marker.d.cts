export interface FenceMarkerIdentity {
    readonly markerDev: string
    readonly markerIno: string
    readonly parentDev: string
    readonly parentIno: string
}

export interface FenceMarkerLocation {
    readonly attemptId: string
    readonly markerPath: string
}

export interface ApprovedFenceMarker extends FenceMarkerIdentity {
    readonly supervisorPid: number
}

export function readFenceMarkerFile(markerPath: string): { readonly value: unknown; readonly identity: FenceMarkerIdentity } | undefined
export function readApprovedActiveMarker(fence: FenceMarkerLocation, approved: ApprovedFenceMarker): Record<string, unknown> | undefined
export function replaceApprovedActiveMarker(
    fence: FenceMarkerLocation,
    approved: ApprovedFenceMarker,
    writer: string,
    fields: Readonly<Record<string, unknown>>,
): boolean
export function syncDirectory(directory: string): void
