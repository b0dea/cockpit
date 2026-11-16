import { lstat, readFile, realpath } from 'node:fs/promises'
import { openCodePatternUnsafe } from '../served-checkout-grants.js'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderBrowserSurfaces } from '../../browser/surfaces.js'
import { resolveBrowserRuntime } from '../../browser/runtime.js'
import { resolveObservationPostures } from '../posture-observation.js'
import { ADOPTABLE_SURFACE_PATHS, SURFACE_FEATURES, SURFACE_TARGETS, type RenderedSurfaceFile, type SurfaceSourceFile, type SurfaceTarget } from '../../surfaces/contract.js'
import { GUARD_SURFACE_TARGETS, harnessFact, isGuardSurfaceTarget, listedSurfaceTargets } from '../../surfaces/harness-registry.js'
import { adoptedCopyPath, mergeAdoptedSurface } from '../../surfaces/adoption.js'
import { generateSurfaceEstate } from '../../surfaces/generator-adapter.js'
import { mergeSurfaceDeclarations } from '../../surfaces/merge.js'
import {
    CORE_EVALUATOR_ASSET as EVALUATOR_ASSET,
    CORE_PROCEDURE_ASSETS as PROCEDURE_ASSETS,
    CORE_SKILL_ASSETS as SKILL_ASSETS,
    coreSurfaceDeclarations,
} from '../../surfaces/core-declarations.js'
import { collectMcpDeclarations, mcpApprovalDigest, parseMcpDeclarationFile, type McpDeclaration } from '../../surfaces/mcp.js'
import {
    bindSurfaceOwnershipIdentity,
    type SurfaceDesiredEntry,
    type SurfacePriorOwnedEntry,
} from '../../surfaces/ownership.js'
import {
    observeSiblingGuides,
    planSiblingProjection,
    type GuideObservation,
    type ProjectionPlannerInput,
    type StandingCost,
} from '../../surfaces/projection.js'
import { renderSurfaceSet, type SurfaceInputEvidence } from '../../surfaces/render.js'
import { stripDevelopmentMarkers } from '../../surfaces/development-markers.js'
import { renderConsumerInstructions } from '../../surfaces/consumer-instructions.js'
import { expandRestrictions } from '../../surfaces/restrictions.js'
import { GUARD_LOCAL_PATHS, parseGuardLocalIdentity, type GuardHandlerIdentity } from '../../guards/local-identity.js'
import { fileFingerprint, verifiedDigest } from '../../environment-exec/verified-digest.js'
import { SHIPPED_SETUP_SKILL, extendInspectedSkillStandingCosts, inspectRenderedSkillSet } from '../../surfaces/skill-contract.js'
import { readAnchoredFile, readAnchoredEntry, readAnchoredBatches } from '../../generated-environment/transaction.js'
import { ENVIRONMENT_CODES, errorCause, hasErrorCode, snapshotGeneratedJson, RefusalError } from '../contract.js'
import { mounted, SIBLING_DEFAULT_GUIDES } from '../../schema.js'
import { checkoutId, cockpitId, stackId } from '../identity.js'
import { resolveLifecycleStage } from '../lifecycle-stage.js'
import { observeConfiguration, selectStateRoot } from '../state.js'
import { TESTING_GUIDE_REGISTRY, createGateRegistry, renderTierGuide } from '../../testing/gates.js'
import { refusalOutcome as refuse } from '../../refusal.js'
import {
    type AdoptedSourceIdentity,
    CODEX_PROJECT_DOC_BYTES,
    type ConsumedWorkApplicationAuthorities,
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedSurfaceHealthEvidence,
    type GeneratedSurfaceManifestProjection,
    MAX_GENERATED_BYTES,
    MAX_OWNED_FILES,
    MAX_SURFACE_FILE_BYTES,
    type PreparedEnvironment,
    REFERENCE_ASSETS,
    RESTRICTION_ASSETS,
    type RefusalOutcome,
    SURFACE_ROOT,
    type SourceRootIdentity,
    type SurfaceAssetPath,
    WORK_ASSETS,
    type WorkApplicationAuthorityRecord,
    activeClaudeImports,
    compareCodeUnits,
    guideBytesExceeded,
    guideCapExceeded,
    guideLines,
    readSurfaceAsset,
    sha256,
    siblingGuideMissing,
    siblingRootsCurrent,
    skillDescription,
    sourceIdentity,
} from './shared.js'
import {
    GUIDE_LOAD_CHARACTERIZATIONS,
    alwaysLoadedRule,
    bindNativeGrantsToMcp,
    emptyGeneration,
    expectedSurfaceOutputs,
    nativeFragmentSet,
    nativeGrantFragmentSet,
    nativeGrantPaths,
    nativeMcpPaths,
    nativeSources,
    openCodeReadDenials,
} from './surface-outputs.js'

export async function prepareSurfaces(
    prepared: PreparedEnvironment,
    priorOwned: readonly SurfacePriorOwnedEntry[],
    adapters: GeneratedEnvironmentCommandAdapters,
    approveDeclaredMcp = false,
): Promise<PreparedEnvironment | RefusalOutcome> {
    const config = prepared.registry.config
    // Only the listed tools are rendered and drift-checked; an unlisted tool's files become stale.
    const tools = listedSurfaceTargets(config.surfaces.tools)
    const guardedTools = GUARD_SURFACE_TARGETS.filter(target => tools.includes(target))
    // Generated files are one per checkout, so they follow the declared default profile set; a
    // profile one run adds with `up --profile` reaches the stack, not the agents' instructions.
    const selected = mounted(config, config.environment.profiles)
    const requiredSlugs = new Set([...selected.map(row => row.slug), ...prepared.registry.mcpSources.map(row => row.slug)])
    const siblingRoots = new Map<string, string>()
    const sourceRoots: SourceRootIdentity[] = []
    if (!await siblingRootsCurrent(prepared.siblingRoots)) return refuse(
        'GENERATED_SIBLING_ROOT_INVALID', 'a sibling directory changed after its root authority was authenticated', 'sibling',
    )
    try {
        for (const sibling of config.sibling.filter(row => requiredSlugs.has(row.slug))) {
            const authority = prepared.siblingRoots.siblings.get(sibling.slug)
            if (!authority) throw new RefusalError('root')
            const root = authority.root
            const status = await lstat(root)
            if (!status.isDirectory() || status.isSymbolicLink()) throw new RefusalError('root')
            siblingRoots.set(sibling.slug, root)
            sourceRoots.push({ slug: sibling.slug, root, identity: authority.identity })
        }
    } catch (error) {
        return refuse('SURFACE_SOURCE_UNAVAILABLE', `an active sibling checkout could not be authenticated: ${errorCause(error)}`, 'surfaces')
    }
    // A root guide that projection also writes would become both an authenticated input and an
    // owned output. Native harness loading already reaches these files, so a copy adds no rule.
    const rootInstructionOutputs = new Set(['AGENTS.md', 'CLAUDE.md', 'opencode.jsonc'])
    const projectionGuides = (sibling: typeof config.sibling[number]): readonly string[] =>
        siblingRoots.get(sibling.slug) === prepared.root
            ? sibling.guides.filter(guide => !rootInstructionOutputs.has(guide))
            : sibling.guides
    const guideRequests = selected.flatMap(sibling => projectionGuides(sibling).map(guide => ({
        slug: sibling.slug, root: siblingRoots.get(sibling.slug)!, sourcePath: resolve(siblingRoots.get(sibling.slug)!, guide),
    }))).sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath))
    const observedGuides = guideRequests.length === 0
        ? { kind: 'complete' as const, observations: [] as readonly GuideObservation[], missing: [] as readonly string[] }
        : await observeSiblingGuides({ allowedRoots: selected.map(row => siblingRoots.get(row.slug)!), requests: guideRequests,
            instances: prepared.registry.secretPaths.flatMap(row => siblingRoots.has(row.slug) ? [resolve(siblingRoots.get(row.slug)!, row.path)] : []) })
    if (observedGuides.kind !== 'complete') return refuse(observedGuides.diagnostic.code, observedGuides.diagnostic.message, observedGuides.diagnostic.target)
    for (const sibling of selected) for (const guide of projectionGuides(sibling)) {
        const sourcePath = resolve(siblingRoots.get(sibling.slug)!, guide)
        if (!SIBLING_DEFAULT_GUIDES.includes(guide) && observedGuides.missing.includes(sourcePath)) return siblingGuideMissing(sibling.slug, guide, sourcePath)
    }
    const projectionInput: ProjectionPlannerInput = {
        canonicalMainCheckout: prepared.root,
        siblingsRoot: config.cockpit.siblings_root,
        activeProfiles: [...config.environment.profiles],
        guideCapLines: config.cockpit.guide_cap,
        siblings: config.sibling.map(row => ({ slug: row.slug, mount: row.mount, directoryAuthority: row.dir, guides: [...projectionGuides(row)] })),
        mountedPaths: selected.map(row => ({ slug: row.slug, path: siblingRoots.get(row.slug)! })),
        directoryGrants: selected.flatMap(row => tools.map(target => ({ slug: row.slug, target, path: siblingRoots.get(row.slug)! }))),
        guideObservations: observedGuides.observations,
        standingSources: [],
        loadCharacterizations: GUIDE_LOAD_CHARACTERIZATIONS,
        targets: tools,
    }
    let projection = planSiblingProjection(projectionInput)
    if (projection.kind !== 'complete') return refuse(projection.diagnostic.code, projection.diagnostic.message, projection.diagnostic.target)

    const evidence: SurfaceInputEvidence[] = observedGuides.observations.map(row => ({
        kind: 'guide' as const, root: siblingRoots.get(row.slug)!, path: row.sourcePath,
        sha256: row.contentSha256, identity: row.contentIdentity,
    }))
    const declarations: McpDeclaration[] = []
    for (const source of prepared.registry.mcpSources) {
        const root = siblingRoots.get(source.slug)
        if (!root) continue
        const read = await readAnchoredFile(root, source.path, MAX_GENERATED_BYTES, prepared.node, adapters)
        if (read.kind !== 'complete') return refuse('MCP_DECLARATION_INVALID', 'an MCP declaration source is unavailable', source.path)
        let bytes: string
        try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
            // undecodable bytes are malformed input the caller refuses.
            return refuse('MCP_DECLARATION_INVALID', 'an MCP declaration source is not UTF-8', source.path)
        }
        const parsed = parseMcpDeclarationFile({ bytes, source: { kind: 'sibling', slug: source.slug, path: source.path, sha256: read.sha256 }, workingDirectory: root })
        if (parsed.kind !== 'complete') return refuse(parsed.diagnostic.code, parsed.diagnostic.message, source.path)
        declarations.push(...parsed.declarations)
        evidence.push({ kind: 'mcp' as const, root, path: source.path, sha256: read.sha256, identity: sourceIdentity(read.identity) })
    }
    // Only the digests a person approved at `sync --interactive` are approved. That preview renders
    // every declared server as approved and lists each with what it starts, so the person sees what a
    // yes enables, including a server whose approval an unsynced edit of cockpit.toml added.
    const declaredDigests = Object.fromEntries(declarations.map(row => [row.name, mcpApprovalDigest(row, prepared.root)]))
    const mcpApprovals = !approveDeclaredMcp ? [] : Object.entries(declaredDigests).map(([name, sha256]) => {
        const rows = declarations.filter(row => row.name === name)
        const row = rows[0]!
        const command = (launch: Readonly<{ command: string; args: readonly string[]; cwd: string }>) =>
            `${[launch.command, ...launch.args].join(' ')} (in ${relative(prepared.root, launch.cwd) || '.'})`
        const runs = 'url' in row ? `${row.url}${row.helper ? `, with headers from ${command(row.helper)}` : ''}` : command(row)
        return { name, sha256, approved: config.mcp.approved[name] === sha256, runs,
            sources: rows.map(({ source }) => source.kind === 'sibling' ? `${source.slug}:${source.path}` : source.path) }
    })
    const approved = approveDeclaredMcp ? { ...config.mcp.approved, ...declaredDigests } : config.mcp.approved
    let mcp = collectMcpDeclarations({ cockpitDirectory: prepared.root, declarations, approved, allowedTools: config.mcp.allowed_tools, targets: tools })
    if (mcp.kind !== 'complete') return refuse(mcp.diagnostic.code, mcp.diagnostic.message, mcp.diagnostic.server)
    const unapprovedMcpServers = mcp.diagnostics.filter(row => row.code === 'MCP_NOT_APPROVED' && row.server !== undefined)
        .map(row => ({ name: row.server!, sha256: row.sha256!, sources: (row.sources ?? []).map(source =>
            source.kind === 'sibling' ? `${source.slug}:${source.path}` : source.path) }))
    const mcpTransportGaps = mcp.diagnostics.filter(row => row.code === 'MCP_TRANSPORT_UNAVAILABLE' && row.server !== undefined)
        .map(row => ({ name: row.server!, targets: row.targets ?? [], reason: row.message }))
    if (mcp.diagnostics.some(row => row.code === 'MCP_APPROVAL_UNKNOWN')) {
        const row = mcp.diagnostics.find(candidate => candidate.code === 'MCP_APPROVAL_UNKNOWN')!
        return refuse(row.code, row.message, row.server)
    }

    const assetPaths = [EVALUATOR_ASSET, ...SKILL_ASSETS, ...REFERENCE_ASSETS, ...RESTRICTION_ASSETS, ...WORK_ASSETS]
    const assetReads = await readAnchoredBatches(SURFACE_ROOT, assetPaths.map(path => ({
        path, maxBytes: MAX_SURFACE_FILE_BYTES, action: 'read-file' as const,
    })), prepared.node, adapters)
    if (!assetReads || assetReads.kind !== 'complete' || assetReads.results.length !== assetPaths.length) {
        return refuse('SURFACE_INPUT_INVALID', 'a shipped surface asset could not be authenticated', 'surfaces')
    }
    const assetRows = assetPaths.map((path, index) => readSurfaceAsset(path, assetReads.results[index]!))
    if (assetRows.some(row => row === undefined)) return refuse('SURFACE_INPUT_INVALID', 'a shipped surface asset could not be authenticated', 'surfaces')
    const assets = assetRows as readonly NonNullable<typeof assetRows[number]>[]
    const asset = (path: SurfaceAssetPath): NonNullable<typeof assetRows[number]> => assets.find(row => row.path === path)!
    let browser: ReturnType<typeof renderBrowserSurfaces> | null = null
    let browserAuthority: ConsumedWorkApplicationAuthorities['browser']
    if (prepared.workEnvironment.browser) {
        const checkout = prepared.checkoutIdentity
        const browserConfiguration = prepared.workEnvironment.browser
        const playwright = declarations.filter(row => row.name === 'playwright')
            .flatMap(row => 'command' in row ? [row] : [])
        if (playwright.length !== 1 || declarations.filter(row => row.name === 'playwright').length !== 1) {
            return refuse('MCP_DECLARATION_INVALID',
                `[browser] requires exactly one local-command MCP server named playwright, and the declared MCP sources hold ${declarations.filter(row => row.name === 'playwright').length} servers by that name, ${playwright.length} of them local`, 'playwright',
                'declare one playwright server with a command (not a url) in a JSON file with an mcpServers object, listed in a sibling\'s derives.mcp_sources, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>')
        }
        const playwrightDigest = mcpApprovalDigest(playwright[0]!, prepared.root)
        if (approved.playwright !== playwrightDigest) {
            return refuse('MCP_DECLARATION_INVALID', '[browser] requires the playwright MCP server to be approved at its current declaration', 'playwright',
                'a person runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> --interactive in a terminal outside the agent, reviews the playwright declaration it shows and answers yes')
        }
        if (process.platform !== 'darwin' && process.platform !== 'linux') {
            return refuse('SURFACE_INPUT_INVALID', 'browser posture state is unavailable on this platform', process.platform)
        }
        const observedAt = new Date().toISOString()
        const currentStack = stackId({ cockpitId: checkout.cockpitId, checkoutId: checkout.checkoutId, variant: { kind: 'shared' } })
        const configuration = (await observeConfiguration({ path: prepared.configPath, stackId: currentStack, observedAt }))
            .find(({ code }) => code === ENVIRONMENT_CODES.CONFIG_STALE)
        const namespace = await selectStateRoot({
            platform: process.platform,
            home: process.env.HOME,
            xdgStateHome: process.env.XDG_STATE_HOME,
            checkoutRoots: [checkout.currentCheckoutPath, checkout.mainCheckoutPath],
            cockpitId: checkout.cockpitId,
        })
        if (!configuration) {
            return refuse('SURFACE_INPUT_INVALID', 'browser posture authority could not be observed', prepared.configPath)
        }
        if (namespace.kind !== 'complete') return namespace.kind === 'refusal'
            ? refuse(namespace.code, namespace.message, namespace.target)
            : refuse('SURFACE_INPUT_INVALID', `browser posture state is ${namespace.kind}`, prepared.root)
        try {
            const authority = await resolveObservationPostures({
                configuration,
                cockpitId: checkout.cockpitId,
                checkoutPath: checkout.currentCheckoutPath,
                variant: { kind: 'shared' },
            })
            const stage = await resolveLifecycleStage({ namespace: namespace.value, stackId: currentStack, observedAt })
            if (stage.kind !== 'complete') return refuse('SURFACE_INPUT_INVALID', 'browser lifecycle authority could not be observed', prepared.root)
            const configuredRuntime = resolveBrowserRuntime({
                ...browserConfiguration,
                postures: { authorities: [authority], stages: [stage.authority] },
            }, namespace.value)
            const runtime = configuredRuntime
            const browserMcp = playwright[0]!
            const browserSkill = asset('skills/cockpit-browser.skill.md')
            browser = renderBrowserSurfaces({
                runtime,
                cockpitDirectory: prepared.root,
                harnesses: browserConfiguration.harnesses.flatMap(row => isGuardSurfaceTarget(row.target)
                    ? [{ target: row.target, version: row.version }] : []),
                mcp: browserMcp,
                approved: true,
                ...(config.mcp.allowed_tools.playwright === undefined ? {} : { allowedTools: config.mcp.allowed_tools.playwright }),
                testPackage: null,
                skillTemplate: browserSkill.bytes,
            })
            const browserTargets = new Set(browser.mcp.result.harnesses
                .filter(row => row.servers.some(server => server.name === 'playwright'))
                .map(row => row.target))
            const boundMcp = collectMcpDeclarations({
                cockpitDirectory: prepared.root,
                allowedTools: Object.fromEntries(Object.entries(config.mcp.allowed_tools)
                    .filter(([name]) => name !== 'playwright' || browserTargets.size > 0)),
                declarations: declarations.flatMap(row => row.name !== 'playwright' ? [row]
                    : browserTargets.size ? [browserMcp] : []),
                // The leased endpoint rewrites an approved argument, so the bound server carries its own digest.
                approved: { ...Object.fromEntries(Object.entries(approved).filter(([name]) => name !== 'playwright')),
                    ...(browserTargets.size > 0 ? { playwright: mcpApprovalDigest(browserMcp, prepared.root) } : {}) },
                targets: tools,
            })
            if (boundMcp.kind !== 'complete') throw new RefusalError(`bound browser MCP declaration was refused: ${boundMcp.diagnostic.code}`)
            mcp = { ...boundMcp, result: { ...boundMcp.result,
                harnesses: boundMcp.result.harnesses.map(row => ({ ...row,
                    servers: row.servers.filter(server => server.name !== 'playwright' || browserTargets.has(row.target)),
                })),
            } }
            browserAuthority = {
                runtime,
                namespace: namespace.value,
                mcp: browserMcp,
                skillTemplate: browserSkill,
            }
        } catch (error) {
            return refuse('SURFACE_INPUT_INVALID', `browser surface projection was refused: ${errorCause(error)}`, 'browser')
        }
    }
    const testingRegistry = prepared.workEnvironment.testing
        ? createGateRegistry(prepared.workEnvironment.testing.declarations)
        : TESTING_GUIDE_REGISTRY
    const configuredHarnesses = [...tools].sort()
    const coreAssets = new Map(assets.map(row => [row.path, row] as const))
    // The browser server as Claude Code gets it, so the evaluator's tool list admits exactly its tools.
    const claudeBrowser = browser ? mcp.result.harnesses.find(row => row.target === 'claudecode')?.servers.find(server => server.name === 'playwright') : undefined
    const coreDeclarations = coreSurfaceDeclarations(coreAssets, tools, claudeBrowser)
    if (!coreDeclarations) return refuse('SURFACE_INPUT_INVALID', 'the shipped core surface declarations could not be read', 'skills/collection.json')
    const shippedSkills = coreDeclarations.filter(declaration => declaration.feature === 'skills').map(declaration => declaration.name)
    const merge = mergeSurfaceDeclarations(coreDeclarations, config.surfaces.overlays)
    if (merge.kind !== 'complete') return refuse(merge.code, merge.message, 'surfaces')
    const mergedSources: SurfaceSourceFile[] = []
    for (const source of merge.surfaces.flatMap(surface => surface.sources)) {
        if (!source.path.startsWith('rules/')) { mergedSources.push({ path: source.path, bytes: source.bytes }); continue }
        const rule = alwaysLoadedRule(source.bytes)
        if (rule.kind === 'refusal') return refuse('SURFACE_RULE_SCOPE_UNSUPPORTED', `rules overlay ${source.path} ${rule.reason}`, source.path,
            'remove `globs` from the rule frontmatter, or narrow the rule text itself to the files it is about, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>')
        mergedSources.push({ path: source.path, bytes: rule.bytes })
    }
    // Every sibling directory relative to the cockpit root, whether or not a grant names it.
    const siblingDirectories = [...prepared.siblingRoots.siblings].map(([slug, sibling]) => ({ slug, path: relative(prepared.root, sibling.root) }))
    const generatedNativeSources = nativeSources(mcp, projection.grants, siblingDirectories, prepared.registry.secretPaths, config.guards.secret_paths)
    const generatedSources = [...mergedSources, ...generatedNativeSources]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    if (new Set(generatedSources.map(source => source.path)).size !== generatedSources.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'surface source paths collide with generated native sources', 'surfaces')
    }
    const features = SURFACE_FEATURES.filter(feature => generatedSources.some(source => source.path === `${feature}.jsonc`
        || source.path.startsWith(`${feature}/`) || feature === 'rules' && source.path.startsWith('rules/')
        || feature === 'subagents' && source.path.startsWith('subagents/') || feature === 'skills' && source.path.startsWith('skills/')))
    const expected = expectedSurfaceOutputs(tools, features, generatedSources)
    const estate = generatedSources.length === 0 ? undefined : await generateSurfaceEstate({
        batch: { targets: tools, features, sources: generatedSources, expectedOutputs: expected },
    })
    if (estate && estate.kind !== 'complete') {
        // The generator prints its warnings before the error that stopped it, then a stack; lead with
        // that error and drop the stack, which names only the worker's scratch files.
        const failure = estate.diagnostics[0]
        const said = failure?.stderr?.split('\n').map(line => line.trim().replace(/^Error: /, ''))
            .filter(line => line.length > 0 && !/^at /.test(line)) ?? []
        const cause = said.at(-1)
        return refuse('SURFACE_GENERATION_FAILED', [cause, failure?.message ?? 'built-in surface generation was refused',
            ...said.length > 1 ? [`generator output: ${said.slice(0, -1).join(' ')}`] : []]
            .filter((part): part is string => part !== undefined).join('; '), failure?.target)
    }
    const generated = estate?.kind === 'complete' ? estate.batch : emptyGeneration()

    const skillSources = generatedSources.filter(source => source.path.startsWith('skills/'))
    const skillAsset = (path: SurfaceAssetPath) => {
        const { bytes, sha256 } = asset(path)
        return { path, bytes, sha256 }
    }
    const skillInspection = await inspectRenderedSkillSet({ sources: skillSources,
        declaredExtensions: config.surfaces.overlays.filter(overlay => overlay.feature === 'skills')
            .flatMap(overlay => overlay.sources.flatMap(source => /^skills\/([^/]+)\/SKILL\.md$/.exec(source.path)?.[1] ?? []))
            .filter(name => !shippedSkills.some(shipped => shipped === name))
            .sort(compareCodeUnits),
        collection: skillAsset('skills/collection.json'), procedures: PROCEDURE_ASSETS.map(skillAsset), generated, targets: tools })
    if (skillInspection.kind !== 'complete') {
        const diagnostic = skillInspection.diagnostics[0]
        return refuse(diagnostic?.code ?? 'SKILL_RENDER_INVALID', diagnostic?.message ?? 'rendered skill set was refused', diagnostic?.target)
    }

    let modulePath: string
    try { modulePath = await realpath(fileURLToPath(new URL('../../../dist/cli.js', import.meta.url))) }
    catch (error) { return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', `the installed guard handler is unavailable: ${errorCause(error)}`, 'guard') }
    // The guard runs the module sync binds. A copy of cockpit, which an agent can edit, would become the
    // guard if its sync bound it, so sync binds only the cockpit installed under the root; a root without
    // one, such as cockpit's own development checkout, keeps the module it is already bound to.
    const installedModule = join(prepared.root, 'node_modules/@b00dea/cockpit/dist/cli.js')
    let installed: string | undefined
    let boundModule: string | undefined
    try {
        installed = await realpath(installedModule)
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', `the installed cockpit could not be resolved: ${errorCause(error)}`, 'guard')
    }
    try {
        boundModule = parseGuardLocalIdentity(await readFile(join(prepared.root, GUARD_LOCAL_PATHS.identity), 'utf8'))?.module
    } catch (error) {
        if (!hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', `the guard identity could not be read: ${errorCause(error)}`, 'guard')
    }
    if (installed !== undefined ? installed !== modulePath : boundModule !== undefined && boundModule !== modulePath) {
        return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', `this cockpit runs from ${modulePath}, not the ${installed !== undefined ? `installed cockpit at ${installed}` : `module the guard is bound to, ${boundModule}`}, `
            + 'and the guard would run whichever copy sync binds', 'guard', 'run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` in a terminal, from the installed package')
    }
    const moduleRead = await readAnchoredFile(dirname(modulePath), basename(modulePath), MAX_GENERATED_BYTES, prepared.node, adapters)
    if (moduleRead.kind !== 'complete') return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', 'the installed guard handler is unavailable', 'guard')
    const rootStat = await lstat(prepared.root)
    const configStat = await lstat(prepared.configPath)
    // Only a fingerprint this process hashed to the authenticated digest may stand in for a re-hash.
    const nodeFingerprint = fileFingerprint(prepared.node.canonicalPath, await lstat(prepared.node.canonicalPath))
    if (verifiedDigest(nodeFingerprint) !== prepared.node.sha256) return refuse('GENERATED_EXECUTABLE_UNAVAILABLE',
        'the Node executable changed while sync was running', 'guard', 'run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>` again in a terminal')
    // The hook runs this Node by the path the search path names it, so a package manager's link that an
    // upgrade re-points keeps the guard working; a Node the search path does not name first runs by its own path.
    let node = prepared.node.canonicalPath
    for (const entry of (process.env.PATH ?? '').split(':').filter(entry => entry.startsWith('/'))) {
        const candidate = join(entry, 'node')
        let resolved: string
        try { resolved = await realpath(candidate) } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP')) continue
            return refuse('GENERATED_EXECUTABLE_UNAVAILABLE', `${candidate} on the search path could not be resolved: ${errorCause(error)}`, 'guard')
        }
        if (resolved === node) node = candidate
        break
    }
    const guardHandler: GuardHandlerIdentity = { root: prepared.root,
        rootInode: String(rootStat.ino),
        configPath: prepared.configPath, configSha256: prepared.sourceSha256,
        configInode: String(configStat.ino),
        node, nodeSha256: prepared.node.sha256, nodeFingerprint, module: modulePath, moduleSha256: moduleRead.sha256 }
    const restrictions = expandRestrictions({
        canonicalProjectRoot: prepared.root,
        restrictedMcpServers: Object.keys(config.mcp.allowed_tools).sort(compareCodeUnits),
        allowedProjectRoots: [...new Set([prepared.root, ...selected.map(row => siblingRoots.get(row.slug)!)])].sort(compareCodeUnits),
        guardTemplate: asset(RESTRICTION_ASSETS[0]).bytes, guardPath: '.cockpit/guards/bash-guard.sh',
        instances: prepared.registry.secretPaths.filter(row => siblingRoots.has(row.slug)).map(row => ({
            kind: 'instance' as const, name: `${row.slug}-${sha256(row.path).slice(0, 12)}`, root: siblingRoots.get(row.slug)!, path: row.path,
        })),
        policy: { hosted_db_hosts: config.guards.hosted_db_hosts, protected_branches: config.guards.protected_branches,
            readonly: { kind: 'agent', name: 'evaluator' } },
        adapters: RESTRICTION_ASSETS.slice(1).map(path => JSON.parse(asset(path).bytes)),
        configFile: relative(prepared.root, prepared.configPath),
    })
    if (restrictions.kind !== 'complete') return refuse(restrictions.code, restrictions.message, 'surfaces')
    const listedRestrictions = { ...restrictions,
        targets: restrictions.targets.filter(row => tools.includes(row.target)) }

    const mcpTargets = mcp.result.harnesses.filter(row => row.servers.length > 0).map(row => row.target)
    // OpenCode's permission block carries its read and guard-file denials as well as directory grants,
    // so it is written for a listed OpenCode whether or not any sibling is granted.
    const grantTargets = [...new Set([...projection.grants.map(row => row.target), ...tools.filter(target => target === 'opencode')])]
    const generatedNativeMcp = nativeFragmentSet(generated, mcp.result, nativeMcpPaths(mcpTargets))
    const nativeGrants = nativeGrantFragmentSet(generated, projection.grants, nativeGrantPaths(grantTargets),
        openCodeReadDenials(siblingDirectories, prepared.registry.secretPaths, config.guards.secret_paths))
    const nativeMcp = generatedNativeMcp && nativeGrants ? bindNativeGrantsToMcp(generatedNativeMcp, nativeGrants) : undefined
    if (!nativeMcp || !nativeGrants) return refuse('SURFACE_INPUT_INVALID', 'native surface fragments could not be bound', 'surfaces')
    const browserSkillRendered = browser?.files.some(file => file.path.endsWith('/skills/cockpit-browser/SKILL.md')) === true
    const instructions = renderConsumerInstructions({
        name: config.cockpit.name,
        configFile: relative(prepared.root, prepared.configPath),
        siblings: config.sibling.map(row => ({ dir: row.dir, purpose: row.purpose, acquire: row.acquire })),
        hasStack: config.environment.compose_files.length > 0,
        guards: { declaredDatabaseHosts: config.guards.hosted_db_hosts, declaredVendorHosts: config.guards.vendor_endpoint_hosts,
            pushRefusedBranches: config.guards.protected_branches },
        skills: [
            ...merge.surfaces.filter(surface => surface.feature === 'skills').flatMap(surface => surface.sources
                .filter(source => /^skills\/[^/]+\/SKILL\.md$/.test(source.path))
                .map(source => ({ name: source.path.split('/')[1]!, description: skillDescription(source.bytes) }))),
            ...(browserSkillRendered ? [{ name: 'cockpit-browser', description: skillDescription(asset('skills/cockpit-browser.skill.md').bytes) }] : []),
        ],
    })
    const generatedRootInstructions = generated.files.filter(file => file.path === 'AGENTS.md')
    const distinctGeneratedRoots = [...new Set(generatedRootInstructions.map(file => file.bytes))]
    if (distinctGeneratedRoots.length > 1) return refuse(
        'SURFACE_PATH_CONFLICT', 'generated root instructions diverge across always-loaded harnesses', 'AGENTS.md',
    )
    const rootInstructions = distinctGeneratedRoots[0]
    const commonRootInstructions = [rootInstructions?.replace(/\n+$/u, ''), instructions.replace(/\n+$/u, '')]
        .filter((value): value is string => value !== undefined && value.length > 0).join('\n') + '\n'
    projectionInput.standingSources = guardedTools.map(target => ({
        target,
        path: 'AGENTS.md',
        content: commonRootInstructions,
        scope: 'always' as const,
    }))
    projection = planSiblingProjection(projectionInput)
    if (projection.kind !== 'complete') return refuse(projection.diagnostic.code, projection.diagnostic.message, projection.diagnostic.target)
    const tierGuide = renderTierGuide(testingRegistry, projectionInput)
    if (tierGuide.kind !== 'complete') return tierGuide.exceeded ? guideCapExceeded(tierGuide.exceeded) : refuse('SURFACE_INPUT_INVALID', tierGuide.reason, 'testing-tiers')
    if (!prepared.workEnvironment.testing && tierGuide.bytes !== stripDevelopmentMarkers(asset('references/testing-tiers.md').bytes)) {
        return refuse('SURFACE_INPUT_INVALID', 'the shipped testing tier guide differs from its canonical registry projection', 'references/testing-tiers.md')
    }
    const rendered = renderSurfaceSet({ configuredHarnesses, merge, generated, projection, mcp, restrictions: listedRestrictions, instructions,
        nativeMcp, nativeGrants, browser, browserReference: browser ? asset('references/browser.md').bytes : null,
        skillReferences: REFERENCE_ASSETS.map(path => ({ skill: SHIPPED_SETUP_SKILL, path, bytes: asset(path).bytes })),
        testing: { tierGuide }, sourceEvidence: evidence })
    if (rendered.kind !== 'complete') return refuse(rendered.diagnostic.code, rendered.diagnostic.message, rendered.diagnostic.target)
    const adopted = await mergeAdoptedSurfaces(prepared, rendered.entries, configuredHarnesses, adapters)
    if ('status' in adopted) return adopted
    let adoptedEntries = adopted.entries
    if (adopted.entries.some(entry => entry.path === 'CLAUDE.md')) {
        const existingClaude = await readAnchoredEntry(prepared.root, 'CLAUDE.md', MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
        if (existingClaude.kind === 'invalid') return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide could not be observed safely', 'CLAUDE.md')
        if (existingClaude.kind === 'file') {
            let bytes: string
            try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(existingClaude.bytes) } catch {
                // undecodable bytes are malformed input the caller refuses.
                return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide is not UTF-8', 'CLAUDE.md')
            }
            const priorClaude = priorOwned.find(entry => entry.path === 'CLAUDE.md')
            let unmanaged = bytes
            if (priorClaude?.kind === 'shared-region' && priorClaude.region.format === 'markdown-delimited') {
                const start = bytes.indexOf(priorClaude.region.begin)
                const end = bytes.indexOf(priorClaude.region.end, start + priorClaude.region.begin.length)
                if (start >= 0 && end > start) unmanaged = `${bytes.slice(0, start)}${bytes.slice(end + priorClaude.region.end.length)}`
            }
            const imports = activeClaudeImports(unmanaged)
            if (imports.length > 1) {
                return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide contains ambiguous AGENTS.md imports', 'CLAUDE.md')
            }
            if (priorClaude === undefined && bytes.includes('<!-- cockpit:')) {
                return refuse('SURFACE_STATE_CONFLICT', 'the existing Claude guide contains an unowned cockpit marker', 'CLAUDE.md')
            }
            if (imports.length === 1) {
                adoptedEntries = adopted.entries.filter(entry => entry.path !== 'CLAUDE.md')
            }
        }
    }
    const bound = bindSurfaceOwnershipIdentity(adoptedEntries, prepared.cockpitId)
    if (bound.kind !== 'complete') return refuse(bound.diagnostic.code, bound.diagnostic.message, bound.diagnostic.target)
    const surfaceEntries = [...bound.entries]
        .sort((left, right) => compareCodeUnits(left.path, right.path))
    const browserSkillFiles: RenderedSurfaceFile[] = []
    const renderedBrowserSkills = browser?.files.filter(file => file.path.endsWith('/skills/cockpit-browser/SKILL.md')) ?? []
    const publishedBrowserSkills = surfaceEntries.filter(entry => entry.path.endsWith('/skills/cockpit-browser/SKILL.md'))
    for (const entry of publishedBrowserSkills) {
        if (entry.kind !== 'file') return refuse('SURFACE_INPUT_INVALID', 'the browser skill must be a whole owned file', entry.path)
        for (const target of entry.harnesses) {
            const rendered = renderedBrowserSkills.find(file => file.path === entry.path && file.target === target)
            const bytes = rendered && stripDevelopmentMarkers(rendered.bytes)
            if (!rendered || bytes !== entry.bytes || sha256(bytes) !== entry.sha256) {
                return refuse('SURFACE_INPUT_INVALID', 'the published browser skill differs from its authenticated renderer', entry.path)
            }
            browserSkillFiles.push({ target: rendered.target, path: entry.path, bytes, sha256: entry.sha256 })
        }
    }
    if (renderedBrowserSkills.length !== browserSkillFiles.length
        || renderedBrowserSkills.some(file => !browserSkillFiles.some(published => published.path === file.path && published.target === file.target))) {
        return refuse('SURFACE_INPUT_INVALID', 'the published browser skill inventory is incomplete', 'surfaces')
    }
    const installedSkillInspection = extendInspectedSkillStandingCosts(skillInspection, browserSkillFiles)
    if (installedSkillInspection.kind !== 'complete') {
        const diagnostic = installedSkillInspection.diagnostics[0]
        return refuse(diagnostic.code, diagnostic.message, diagnostic.target ?? 'surfaces')
    }
    const rootGuide = surfaceEntries.find(entry => entry.path === 'AGENTS.md')
    if (!rootGuide || rootGuide.kind !== 'shared-region' || rootGuide.region.format !== 'markdown-delimited') {
        return refuse('SURFACE_INPUT_INVALID', 'the published always-loaded root guide is unavailable', 'AGENTS.md')
    }
    const characterizedGuideCosts = tierGuide.costs.filter(
        (cost): cost is Exclude<StandingCost, { status: 'unavailable' }> => cost.status !== 'unavailable',
    )
    if (characterizedGuideCosts.length !== tierGuide.costs.length) {
        return refuse('SURFACE_INPUT_INVALID', 'published instruction cost is not characterized', 'AGENTS.md')
    }
    // The root region carries the copied sibling guides, so every tool's start-up cost is that region.
    const rootGuideLines = guideLines(rootGuide.region.bytes)
    const actualGuideCosts = characterizedGuideCosts.map(cost =>
        ({ ...cost, value: rootGuideLines, status: rootGuideLines > cost.cap ? 'exceeded' as const : 'within_cap' as const }))
    const rootGuideBytes = Buffer.byteLength(rootGuide.region.bytes)
    if (rootGuideBytes > CODEX_PROJECT_DOC_BYTES) return guideBytesExceeded(rootGuideBytes)
    const overCap = actualGuideCosts.filter(cost => cost.status === 'exceeded').sort((left, right) => right.value - left.value)[0]
    if (overCap) return guideCapExceeded(overCap)
    if (new Set(surfaceEntries.map(entry => entry.path)).size !== surfaceEntries.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'generated surface paths collide', 'surfaces')
    }
    if (new Set([...prepared.owned, ...surfaceEntries].map(entry => entry.path)).size !== prepared.owned.length + surfaceEntries.length) {
        return refuse('SURFACE_PATH_CONFLICT', 'generated environment and surface paths collide', 'surfaces')
    }
    if (prepared.owned.length + surfaceEntries.length > MAX_OWNED_FILES) {
        return refuse('SURFACE_BOUNDS', 'combined generated ownership exceeds the entry bound', 'surfaces')
    }
    const manifestPayload = { schema: 'cockpit-generated-surface-manifest/v1' as const, configuredHarnesses, entries: surfaceEntries }
    const captured = snapshotGeneratedJson(manifestPayload) as unknown as Omit<GeneratedSurfaceManifestProjection, 'manifestSha256'> | undefined
    if (!captured) return refuse('SURFACE_BOUNDS', 'the generated surface manifest exceeds the captured bounds', 'surfaces')
    const payload = { schema: captured.schema, configuredHarnesses, entries: surfaceEntries }
    const surfaceManifest = { ...payload, manifestSha256: sha256(JSON.stringify(payload)) }
    const skillInventory = surfaceEntries.filter((entry): entry is Extract<SurfaceDesiredEntry, { kind: 'file' }> =>
        entry.kind === 'file').flatMap(entry => entry.harnesses.flatMap(target => {
        if (!SURFACE_TARGETS.includes(target as SurfaceTarget)) return []
        const prefix = `${harnessFact(target as SurfaceTarget).outputs.skills}/`
        if (!entry.path.startsWith(prefix) || !/^[^/]+\/SKILL\.md$/.test(entry.path.slice(prefix.length))) return []
        return [{ target, path: entry.path, sha256: entry.sha256 }]
    })).sort((left, right) => compareCodeUnits(`${left.target}\0${left.path}`, `${right.target}\0${right.path}`))
    const installedSkillTargets = new Set(skillInventory.map(({ target }) => target))
    const installedSkillCosts = installedSkillInspection.costs.filter(({ target }) => installedSkillTargets.has(target))
    if (installedSkillCosts.length !== installedSkillTargets.size) {
        return refuse('SURFACE_INPUT_INVALID', 'a published skill target has no admitted standing-cost measurement', 'surfaces')
    }
    const surfaceHealth: GeneratedSurfaceHealthEvidence = {
        observedAt: prepared.producedAt,
        grants: projection.grants.map(grant => ({ ...grant })),
        nativeGrants,
        guideCosts: actualGuideCosts,
        skillCosts: installedSkillCosts,
        skillInventorySha256: sha256(JSON.stringify(skillInventory)),
        skillInventory,
        skills: installedSkillInspection.skills,
        skillCollectionSha256: skillInspection.collection.source.sha256,
    }
    const compactSurfacePaths = new Set(generated.files.map(file => file.path))
    const evaluator = asset(EVALUATOR_ASSET)
    const workApplication: WorkApplicationAuthorityRecord = {
        workEnvironment: prepared.workEnvironment,
        evaluator: {
            path: resolve(SURFACE_ROOT, evaluator.path),
            bytes: evaluator.bytes,
            sha256: evaluator.sha256,
            identity: evaluator.identity,
            restriction: 'instructed',
        },
        installedSkills: surfaceEntries.filter((entry): entry is Extract<SurfaceDesiredEntry, { kind: 'file' }> =>
            entry.kind === 'file' && /^(?:\.agents|\.claude|\.opencode)\/skills\/[^/]+\/SKILL\.md$/.test(entry.path))
            .map(({ path, sha256: digest }) => ({ path, sha256: digest }))
            .sort((left, right) => compareCodeUnits(left.path, right.path)),
        ...(browserAuthority ? { browser: browserAuthority } : {}),
        testing: { registry: testingRegistry },
    }
    const openCodeGrantRoots = projection.grants.filter(grant => grant.target === 'opencode')
        .map(grant => ({ slug: grant.slug, root: siblingRoots.get(grant.slug)! }))
    const unsafeGrant = openCodeGrantRoots.find(row => row.root === undefined || openCodePatternUnsafe(row.root) !== undefined)
    if (unsafeGrant) return refuse('SURFACE_INPUT_INVALID',
        `the directory of sibling ${unsafeGrant.slug} contains *, ?, a quote, a backslash or a control character, which OpenCode would read as part of its access pattern; move the checkout to a plain path`,
        unsafeGrant.slug)
    return { ...prepared, guardHandler, openCodeGrantRoots, unapprovedMcpServers, mcpApprovals, mcpTransportGaps, mcpServers: mcp.result.servers,
        surfaces: surfaceEntries, compactSurfacePaths, configuredHarnesses,
        activeSurfaceOverrides: merge.overrides, changedOverrideOriginals: merge.findings,
        surfaceManifest,
        surfaceHealth,
        guideSources: {
            requests: guideRequests,
            observations: observedGuides.observations.map(row => ({ ...row }))
                .sort((left, right) => compareCodeUnits(left.sourcePath, right.sourcePath)),
            missing: [...observedGuides.missing].sort(compareCodeUnits),
        },
        sourceEvidence: evidence, sourceRoots,
        adoptedSources: adopted.sources,
        surfaceAssets: assets.map(({ path, sha256: digest, identity }) => ({ path, sha256: digest, identity })),
        workApplication,
        warnings: [...rendered.warnings] }
}

const ADOPTED_HARNESS = Object.freeze({ '.claude/settings.json': 'claudecode', '.codex/config.toml': 'codexcli', '.codex/hooks.json': 'codexcli' } as const)

/**
 * Replace each harness settings file the team keeps under cockpit/adopted/ with the merge of that
 * copy and cockpit's rendering. The copy is read through the same anchored reader as every other
 * input and recorded, so publication refuses if it changes before the write.
 */
async function mergeAdoptedSurfaces(
    prepared: PreparedEnvironment,
    entries: readonly SurfaceDesiredEntry[],
    configuredHarnesses: readonly string[],
    adapters: GeneratedEnvironmentCommandAdapters,
): Promise<Readonly<{ entries: readonly SurfaceDesiredEntry[]; sources: readonly AdoptedSourceIdentity[] }> | RefusalOutcome> {
    const merged = [...entries]
    const sources: AdoptedSourceIdentity[] = []
    for (const path of ADOPTABLE_SURFACE_PATHS) {
        const row = { path, source: adoptedCopyPath(path) }
        // Most cockpits adopt nothing; a plain lstat spares each absent copy an anchored helper read.
        try { await lstat(join(prepared.root, row.source)) } catch (error) {
            if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) continue
            return refuse('SURFACE_ADOPTION_REFUSED', `the adopted copy ${row.source} could not be inspected: ${errorCause(error)}`, row.source)
        }
        const read = await readAnchoredFile(prepared.root, row.source, MAX_SURFACE_FILE_BYTES, prepared.node, adapters)
        if (read.kind === 'missing') continue
        if (read.kind !== 'complete') return refuse('SURFACE_ADOPTION_REFUSED',
            `the adopted copy ${row.source} is not a bounded regular file; replace it with the plain settings file or remove it`, row.source)
        let bytes: string
        try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes) } catch {
            // undecodable bytes are malformed input the caller refuses.
            return refuse('SURFACE_ADOPTION_REFUSED', `the adopted copy ${row.source} is not UTF-8 text`, row.source)
        }
        const index = merged.findIndex(entry => entry.path === row.path)
        const current = index < 0 ? undefined : merged[index]!
        if (current && current.kind !== 'file') return refuse('SURFACE_ADOPTION_REFUSED', `cockpit does not render ${row.path} as a whole file`, row.path)
        const result = mergeAdoptedSurface(row.path, bytes, current?.bytes)
        if (result.kind !== 'complete') return refuse(result.diagnostic.code, result.diagnostic.message, result.diagnostic.target)
        const harness = ADOPTED_HARNESS[row.path]
        if (!configuredHarnesses.includes(harness)) return refuse('SURFACE_ADOPTION_REFUSED', `${row.source} belongs to ${harness}, which this cockpit does not configure; list ${harness} in [surfaces] tools or remove the file`, row.source)
        const entry: SurfaceDesiredEntry = current
            ? { ...current, bytes: result.bytes, sha256: sha256(result.bytes) }
            : { kind: 'file', path: row.path, harnesses: [harness] as [string], scope: 'always', capability: 'instructed', writer: 'cockpit',
                schemaVersion: 1, ownership: 'whole-file', bytes: result.bytes, sha256: sha256(result.bytes) }
        if (index < 0) merged.push(entry)
        else merged[index] = entry
        sources.push({ path: row.source, sha256: read.sha256, identity: read.identity })
    }
    merged.sort((left, right) => compareCodeUnits(left.path, right.path))
    return { entries: merged, sources }
}
