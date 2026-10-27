# Environment lifecycle

<!-- cockpit:verified version=0.0.0 -->

This reference explains how cockpit's environment commands behave: what each one owns, what it
refuses, and how to recover. It is for people running cockpit on a product and for agents
working inside it. For the order to run them in, follow
[Bring the product up](getting-started.md#bring-the-product-up); every flag is in the
[CLI reference](cli-reference.md), and `cockpit <command> --help` prints a command's usage.

## Output and exit codes

Add `--json` to get the result and diagnostics as one JSON document on stdout. Without it,
diagnostics and a one-line JSON summary go to stderr. Every refusal exits nonzero with a named
diagnostic code; unknown flags are refused. `logs` defaults to `--tail 100 --since 15m`.

## Input limits

Configuration, registry and adoption files are limited to 1,048,576 bytes before parsing.
Unreadable, non-regular, oversized or concurrently changed inputs refuse with a diagnostic.
Reduce an oversized input; raising an output or subprocess limit does not change this boundary.

`document` can emit a visibly incomplete draft when a registry fact is missing; its JSON result
is `null` for that gap. A skipped registry row emits nothing, because its repository scope may
have been lost. `registry-resolve` emits sourceable shell data only from validated input.

## Sibling and template paths

`sync` and `check` require each declared sibling directory to exist inside the siblings root,
both lexically and after resolving filesystem links. An absolute sibling path is accepted only
inside that root. Acquire missing checkouts before generating their environment.

Generated vendor templates must also lie inside the cockpit checkout. External sibling checkouts
remain valid for mounted surfaces, but a vendor template outside the checkout is refused, and
cockpit never substitutes a similarly named directory inside its own checkout. The
[adoption guide](adoption.md#adopt-in-layers) gives the order for generated templates.

## Lifecycle and ownership

`setup` acquires and wires declared sibling checkouts. `mount` controls how the stack uses a
checkout; `acquire` controls how it reaches disk. They are independent. Setup inspects declared
secret-file paths without reading or copying their contents.

`up` starts or resumes the selected stack. It records a newly acquired holder separately from
an existing holder so a failed start compensates only ownership acquired by that attempt.
Persisted progress is first admitted against the current lifecycle, runtime, and port authority.
When that work remains current, completed services are revalidated before a partial resume;
changed work resets its progress before cockpit touches old container evidence. Failure logs are
bounded, use an exact service and time window, and never follow the process that failed. After the
first seed, missing persisted progress blocks startup. Restore that state; removing durable
history would misrepresent the stack as a fresh environment.

For an invocation that actually starts services, `up` measures from the earliest authenticated
service-start receipt to the final newly started service's healthy observation. It refuses with
`MACHINE_COLD_START_EXCEEDED` when that duration exceeds `cold_start_seconds`. A successful result
reports `coldStart.measuredMillis`, `limitMillis`, and `headroomMillis`. Partial resume measures
only services started by that invocation. An already-running or co-tenant attachment reports no
invented duration.

`sleep` releases the current holder. It stops the shared runtime only when no other holder
remains; one holder cannot stop a second holder's environment. `stackId` names the shared
runtime, while `checkoutId` names a particular checkout. Equal stack identity does not make
two checkouts interchangeable.

`session` runs `up`, keeps that exact holder while one foreground command is
alive, and runs `sleep` only after the command's process group is confirmed stopped. A silent
command remains active. Interrupting the wrapper terminates only that owned process group before
sleeping. If termination of the owned process group cannot be confirmed, the holder is preserved for explicit
cleanup. Ordinary nested cockpit lifecycle commands inherit the same private session identity. A
second `cockpit session` wrapper is refused.

`down` removes only resources selected by authenticated runtime, checkout, and ownership
evidence. `reset` first shows an exact preview of generated volumes and declared generated
host paths. Normal and JSON reset calls do not delete anything. Interactive reset requires a
human terminal outside CI; approval remains in the process that showed the preview and is
revalidated before an action. Set `DOCKER_CONTEXT` explicitly for destructive commands so
discovery and deletion address the same Docker daemon. A conflicting Docker host or TLS
override is refused.

If a destructive attempt ends with `DRAIN_ATTEMPT_REPAIR_REQUIRED`, repair the interrupted
attempt through the owning recovery procedure before retrying. Elapsed time, a missing process,
or a missing target does not prove which action completed. Do not edit the state file directly.

## Secret sources and environment schemas

Keep each product component's `.env.schema` tracked beside its application. If its ignore rules
match `.env.*`, explicitly allow `.env.schema` and confirm that Git tracks it before adoption.
The schema declares variable names, validation and provider resolution; review its resolver code
and dependency lock as product code.

For generated environments, `sync` publishes the owned `env/.secrets/.gitignore` before any secret
material is introduced. It ignores every descendant. Use
`env/.secrets/<cockpit-project>/<component>` for encrypted resolver expressions or external-provider
references. Existing unmanaged ignore bytes require reconciliation; existing secret directories
must be non-symbolic and mode 0700. Cockpit preserves their unowned children. Provision resolver
files mode 0600 through the authorized operator workflow; cockpit does not create their values.

The shared onboarding procedure explains optional Varlock adoption through the product's pinned
dependency and existing declared command or script. Use agent-mode validation for status and
`run --inject vars --redact-stdout` for a trusted product process. Keep the agent's environment
free of resolved credentials. Resolve both paths absolutely: pass the component schema root first
and its cockpit-central resolver directory second with repeated `--path`; the later path wins.
Installation, initialization, provider login, encryption and migration
need explicit product and provider authority. Current commands and limitations are documented in
the [Varlock CLI reference](https://varlock.dev/reference/cli/load-and-run/) and
[AI tools guide](https://varlock.dev/guides/ai-tools/).

Report variable names, validation state, exit status and provenance only. Raw resolver output,
resolved values and browser state do not belong in work-order evidence. Generated guards refuse
mutation and staging beneath secrets directories, including staging an ancestor of the central
store. Native read confinement remains unmeasured. Git ignore, filesystem permissions, encryption
and output redaction do not isolate secrets from malicious code running as the same user; trusted
product children receive plaintext variables. A stronger boundary requires a separately measured
sandbox and provider policy.

## Generated environment

The `[environment.generated]` declaration is the overlay seam for stack content: services,
images, volumes, mounts, data operations, vendor postures, probes, and generated destination
paths. Cockpit owns the rendering and publication mechanism. The declaration owns the values and
operations that differ between products.

`check` derives the current canonical state and compares owned whole files, symlink targets, and
shared regions with the ownership manifest. It reports drift and never mutates an output.
`sync --dry-run` performs the same preparation and reports the ordered writes and removals without
staging or mutation. `sync` publishes the complete owned set as one recoverable filesystem
transaction. A stale removal requires separate approval of the dry run's exact path, operation,
and current-byte request. Plain `sync` refuses that apply; `sync --interactive` previews the
request and requires the operator to type its exact digest. Once independently approved and
revalidated, unchanged whole-file and symlink entries or the owned
region in a shared file can be removed. Unmanaged files and bytes outside owned regions survive.
Changed or unsafe stale paths require manual reconciliation before retrying.
Generated content for a shared Markdown region containing either ownership delimiter is rejected
before publication. Shared JSON updates preserve whitespace outside the owned property group.
The transaction admits its helper schedule before staging and reserves a bounded rollback budget
when forward work reaches its deadline.
If publication or compensation cannot be proved complete, cockpit retains the recovery inputs and
refuses another confident result.

The generated set includes the configured harness surfaces. Their capability states, overlay
rules, MCP approval boundary, sibling projection, skill contract, selftest evidence, and upgrade
sequence are documented in [Harness surfaces](harness-surfaces.md). `upgrade` fails closed unless
given an exact release-evidence file and independently authenticated digest; it does not discover
from a floating tag or install a package. `selftest` accepts only a probe artifact authenticated to the current
source and generated manifest.

Outputs include declared environment paths and configured harness surfaces, so there is no fixed
output count. The repository's
synthetic contract demonstrates a Compose file, a secrets-template projection,
<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md`, and persona projections. The public `sync` and `check`
handlers and their input/output types are the thin adapter in
`packages/cockpit/src/generated-environment/command.ts`; rendering, inspection, ownership, and
transactional publication belong to `packages/cockpit/src/environment/generated-application.ts`
and `packages/cockpit/src/environment/generated-stack.ts`.

Runtime admission binds the stack ID, configuration and source digests, generation, Compose
project, and Compose files. A dependency result also binds the sibling checkout and lockfile,
logical install policy, physical volume and target mount, container image, architecture, ABI,
install receipt, load-probe receipt, and durable stamp. Each sibling keeps its own cache identity,
even when two lockfiles contain the same bytes. A stamp by itself does not prove that the current
runtime can load the installed dependencies. `DEPENDENCY_RUNTIME_STALE`,
`DEPENDENCY_RUNTIME_UNMOUNTED`, and `DEPENDENCY_RUNTIME_INCOMPATIBLE` identify which part of that
binding failed; `DEPENDENCY_RUNTIME_UNAVAILABLE` means current authenticated evidence could not
be obtained.

The data modes are `empty`, `seeded`, and `restored`. Durable outcomes name the exact applied,
attempted, and not-applied operation IDs. Intent, an earlier success, and an unauthenticated or
failed current read-only probe do not count as completion. Persona outputs are rendered only from
the declared authenticated persona source.

The shipped onboarding procedure includes a pull-based authenticated-testing starter. It keeps
stable synthetic persona identifiers and product-owned rows separate from identity-provider
ownership, confirms roles and permissions, directs serial browser-state minting into an ignored
mode-0600 auth root, and asks for both allowed and denied authorization behavior. Its Clerk recipe
uses the consumer's current supported Clerk and Playwright APIs; it does not make cockpit an
identity provider, create provider identities without separate authority, or turn an existing
state file into proof of a live Clerk login. Provider writes and cleanup stay bounded to an
authorized development instance and the exact authorized operation.

Each vendor declaration selects a posture such as `stubbed`, pins every endpoint variable to both
its supplier template and its runtime service and local sink, and declares the applicable route,
loader, shadow, expiry, TLS, callback, stub, and egress probes. A nonempty placeholder remains
inert. An egress flag is supplied only to its guarded process and is never written into generated
files. A generated host-port variable must also be safe for the host process environment: names
that control a loader, interpreter, shell, module path, or container runtime are refused even when
their leased values are numeric.

<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md` is a whole-file-owned generated output. Its declaration
must contain one current dated entry for every service, volume, data default and mode, restore
policy, mount, port, and vendor. Service entries carry the image choice made by the declaration.
Missing, duplicate, future-dated, stale, or sensitive entries refuse inspection. Mechanical
coverage does not establish that a business decision is correct; that semantic review remains
`human_needed`.

Bring-up starts from lifecycle history written by `setup`. It completes current generated-runtime
inspection, dependencies, data, and vendors through the owner callbacks
`completeGeneratedEnvironment`, `completeGeneratedDependencies`, `completeGeneratedData`, and
`completeGeneratedVendors`. Only then does it publish `seeded`. A refusal preserves exact applied,
attempted, and not-applied progress for replay. Repair the named prerequisite or evidence; never
edit lifecycle state to manufacture `started` or `seeded` history.

The evidence words in this reference are deliberate:

- **enforced** means the mechanism refuses a mismatched declaration, byte, ownership record,
  identity, mount, endpoint pin, or unsafe operation.
- **measured** means a bounded authenticated probe produced the stated result. Repository tests
  include mounted candidates beside unmounted and incompatible controls, but those synthetic
  controls do not prove a particular local runtime.
- **unavailable** means a current owner could not issue or authenticate the required evidence. It
  is nonpassing. The native dependency probe remains unavailable until you supply a canonical
  generated configuration, checkout, and pinned incompatible-image control.
- **human_needed** means semantic product or vendor behavior still needs a maintainer review and
  has not been mechanically established.

## Declare environment postures

Declare how local requirements depend on addressing and authentication. For example:

```toml
[environment]
addressing = "hostname"
authentication = "bypassed"
posture_requirements = [
  { requirement = "local-route-resolution", addressing = "hostname" },
  { requirement = "local-session-access", authentication = "bypassed" },
]
```

Use your actual requirement names. Each tag must match the selected posture, and each selected
addressing and authentication posture must appear in at least one tag. Preflight refuses missing
declarations, mismatched tags and unreferenced postures. Draft configurations may omit these
fields, but cannot satisfy that gate. The check validates declared tags; deciding which
requirements need tags remains a maintainer review.

## Health and evidence

`preflight` is the blocking gate; `doctor` reports the same observations without repair or
baseline mutation. Ordinary checks require a steady lifecycle stage. A check can pass, fail,
be unavailable, or be inapplicable under its declared posture. An unavailable required check
does not become a pass because another check succeeded. Configured host capacity, dependency
installation, and runtime health still require complete owner-issued execution evidence; where
that evidence is unavailable, these commands report a nonpassing result. A declared sibling
remote is checked against the remote selected by that checkout's branch upstream. Cockpit
does not rewrite Git remotes.

Generated, dependency, data, and vendor producers return owner-issued observations.
`preflight` and `doctor` consume current read-only observations; doctor previews generated
surfaces to list overrides. They do not apply `sync`, install
dependencies, seed or restore data, contact vendors for repair, or advance lifecycle progress.
Bring-up alone invokes the four completion callbacks described under
[Generated environment](#generated-environment).

`logs` reads one declared service from the selected running stack. `--tail` accepts 1 through
10000 records; `--since` bounds the time range. Records retain stream and restart provenance.
The launcher supplies cancellation for `--follow`; interrupting it returns exit 130 with the
authenticated records collected before the process group stopped. Programmatic callers must
supply an abort signal. Collection remains bounded by the adapter's time and output limits; the
CLI allows ten seconds for collection and reports a timeout as a failure. Output is returned
after collection, including structured records in JSON mode, rather than streamed continuously.

`baseline-record` is the only command that writes an environment baseline. It requires
confirmation of one exact snapshot and runtime-evidence pair; `preflight`, `doctor`, and `logs`
cannot write or advance that baseline. `--interactive` shows the selected stack, evidence
hashes, version, and observation time before asking for approval in a human terminal. It is
the only public recording mode and is unavailable in CI and JSON mode. Approval writes the
admitted evidence pair from that same process once after revalidating the same runtime and
source; a later run cannot reuse the approval.

## Respond to diagnostic codes

Human output always includes diagnostic severity, code, and message, followed by its target and
fix when those fields are present. JSON output preserves the same diagnostic object. The code
identifies the family; it does not make a destructive action safe by itself. After a repair,
re-run `doctor --config <file> --json`; use `preflight --config <file> --json` when the environment must satisfy the blocking gate.

### Configuration and setup input

For `CONFIG_NOT_FOUND`, `CONFIG_UNREADABLE`, `CONFIG_ENCODING_INVALID`, `CONFIG_PARSE_INVALID`,
or `CONFIG_SCHEMA_INVALID`, inspect the named configuration path and correct its encoding,
TOML, or schema error. For `CONFIG_CHANGED_DURING_EXECUTION`, stop concurrent edits and retry
from a configuration you have inspected.

`SETUP_CONFIG_REQUIRED`, `SETUP_OPTION_DUPLICATE`, and `SETUP_POSITIONAL_UNSUPPORTED` indicate
invalid CLI input. Supply one `--config <file>` flag. For `SETUP_PATH_OUTSIDE_ROOT`,
`SETUP_PATH_SYMLINK`, `SETUP_PATH_TYPE_INVALID`, or `SETUP_PARENT_MISSING`, correct the declared
sibling path or its parent. For `SETUP_REMOTE_MISMATCH`, correct the declaration or existing
remote. For `SETUP_MANUAL_MISSING`, perform the declared manual acquisition first.
`SETUP_NONE_ABSENT`, `SETUP_NONE_DIRECTORY`, and `SETUP_NONE_REPOSITORY` mean a checkout declared
with no acquisition is not already present in the required form. `SETUP_POSTCHECK_FAILED` means
the acquired checkout did not match the issued setup plan; inspect it before retrying.

### State, lifecycle, and execution

For `STATE_ROOT_UNAVAILABLE`, inspect the target path and restore a canonical, writable,
non-symlinked state path owned by the current user. Existing path components must not be writable
by group or other users; repair ownership and permissions instead of making them more permissive.
`STATE_FORMAT_UNSUPPORTED` and `STATE_RECORD_MALFORMED` require recovery with a compatible cockpit
version or the owning recovery procedure; do not edit state records by hand. `STATE_LOCKED` means
a state publication is active or its ownership could not be verified; inspect the named holder.
`STATE_DURABILITY_INDETERMINATE` means cockpit could not prove that a state write is durable, so
do not assume it committed.

`EXECUTION_PRECONDITION_CHANGED` means an inspected input changed before execution; inspect the
new input and retry. `EXECUTION_SPAWN_FAILED`, `EXECUTION_STAGING_FAILED`,
`EXECUTION_STAGING_CLEANUP_FAILED`, `EXECUTION_TIMEOUT`, `EXECUTION_STDOUT_LIMIT`,
`EXECUTION_STDERR_LIMIT`, `EXECUTION_STEP_FAILED`, and `EXECUTION_ABORTED` identify the failed
execution boundary. Use its target and bounded stderr to repair the named executable, staging
path, timeout, output volume, or command. `EXECUTION_TERMINATION_UNCONFIRMED` means cockpit sent
termination signals but could not prove the process group exited. Cockpit retains its staging
directory, issues no finished execution receipt, and does not start follow-on compensation while
that process may still be live. Inspect the named process and its ownership, confirm termination,
then use the owning recovery procedure before removing retained staging.
`EXECUTION_COMPENSATION_TIMEOUT` and `EXECUTION_COMPENSATION_STEP_FAILED` mean cleanup also failed;
inspect ownership before another lifecycle command. `LIFECYCLE_EVIDENCE_INVALID` and
`LIFECYCLE_PROGRESS_INVALID` require recovery of owner-issued evidence or persisted progress
before retrying.

### Ports, claims, and dependency installation

For `PORT_FAMILY_COLLISION`, inspect the listener's owner, then stop your conflicting listener
or reconfigure the declared port family.
`PORT_FAMILY_OUT_OF_RANGE` requires a valid declared port family; `PORT_LEASE_EXHAUSTED` requires
releasing a confirmed stale lease or choosing another valid family. `PORT_LISTENER_EVIDENCE_INVALID`
means cockpit could not authenticate the listener observation. `PORT_LOCAL_VALUE_CORRECTED` is an
informational correction to a local value; review it before publishing external configuration.
`PORT_EXTERNAL_REGISTRATION_GAP` means external registration still needs an operator.

`CLAIM_CO_TENANT` means another live holder shares the stack and must not be displaced.
`CLAIM_LIVENESS_UNKNOWN` means holder liveness could not be established. For
`CLAIM_STATE_UNHEALTHY`, inspect claim ownership and liveness; never remove a claim solely because
it is old. `DRAIN_ATTEMPT_REPAIR_REQUIRED` requires the owning recovery procedure described under
[Lifecycle and ownership](#lifecycle-and-ownership).

For `INSTALL_LOCK_HELD`, wait for the live installer. `INSTALL_LOCK_INVALID`,
`INSTALL_STALE_PATH`, and `INSTALL_LOAD_PROBE_FAILED` require inspection of the reported install
path and owner before repair. `INSTALL_LOCKFILE_CHANGED` means the dependency input changed and
must be re-read. For `INSTALL_POLICY_OBSERVATION_UNAVAILABLE`,
`INSTALL_POLICY_OBSERVATION_INVALID`, `INSTALL_POLICY_MISSING`, or `INSTALL_POLICY_AMBIGUOUS`,
make the dependency policy observable and unambiguous before running setup. `INSTALL_STATE_UNHEALTHY`
means the installed result does not satisfy that policy.

### Environment files and runtime

For `TEMPLATE_NOT_FOUND`, `TEMPLATE_NOT_TRACKED`, `TEMPLATE_IGNORED`, or
`TEMPLATE_PATH_OUTSIDE_ROOT`, correct the declared template and keep it tracked within its sibling
root. For `ENVIRONMENT_FILE_NOT_FOUND`, `ENVIRONMENT_FILE_UNREADABLE`,
`ENVIRONMENT_FILE_TOO_LARGE`, or `ENVIRONMENT_FILE_MALFORMED`, repair the reported generated
environment file. `INSTANCE_NOT_IGNORED` requires the generated instance path to be ignored before
cockpit writes it. `ENVIRONMENT_SEED_PRECONDITION_CHANGED` requires a fresh inspection;
`ENVIRONMENT_SEED_FAILED` requires repair of the named seed action. `ENVIRONMENT_KEYS_STALE`
means the generated environment keys no longer match the declared inputs.

`RUNTIME_UNAVAILABLE` and `RUNTIME_PROBE_TIMEOUT` mean runtime evidence could not establish a
healthy local stack. Repair or start the declared runtime, then run the probe again.
`RUNTIME_UNMEASURED` means cockpit could not authenticate bounded runtime inputs or artifacts,
the observed runtime has no exact supported measurement row with a passed candidate and rejected
broken control, or the observed Compose version is below that row's measured floor. Restore safe,
digest-matched local artifacts and canonical measurement inputs. Runtime admission requires a
complete supported row for the observed runtime, a passed candidate, a rejected broken control,
and a Compose version at or above the row's valid measured floor. `RUNTIME_COMPOSE_REMOTE` means
a Compose file escaped the declared root, referred to a remote file, was not safely parseable, or
contained a remote or unsupported build, include, or extends source. Replace it with a confined,
digest-matched local Compose file and supported local build contexts.
`RUNNING_CHECKOUT_MISMATCH` means the running stack belongs to a different checkout; select the
owning checkout instead of reusing its runtime.

### Reset, reclaim, and baselines

`RESET_CONFIRMATION_REQUIRED` requires an interactive human approval of the exact preview.
`RESET_CONFIRMATION_MISMATCH` means the preview changed and must be reviewed again.
`RESET_CO_TENANT` means another holder shares the stack, so reset remains blocked.
`RECLAIM_LABEL_ESCAPE` and `RECLAIM_ACCOUNTING_MISMATCH` mean the candidate resources exceed or
contradict authenticated ownership evidence; stop and inspect the reported labels and accounting.

`EVIDENCE_BASELINE_MISSING` means no admitted baseline exists. `EVIDENCE_UNAVAILABLE` means the
current snapshot or runtime evidence is incomplete. Establish healthy runtime evidence, review
the exact snapshot, and use interactive `baseline-record`; do not substitute `doctor` or
`preflight` for admission.

### Preflight observations

`CONFIG_STALE`, `SIBLING_MISSING`, `GIT_STATE_UNHEALTHY`, `CHECKOUT_ADJACENCY_UNHEALTHY`, and
`GIT_COMPARISON_REMOTE_MISMATCH` identify configuration or checkout drift. Inspect the reported
path and evidence; restore the declared checkout or upstream remote without having cockpit rewrite
Git state. `GUIDE_CAP_EXCEEDED` requires reducing the selected guide set. `SKILL_BUDGET_UNAVAILABLE`
and `HARNESS_SURFACE_UNAVAILABLE` require the declared agent inputs to be made observable.

For `MACHINE_MEMORY_BELOW_FLOOR`, `MACHINE_CPU_BELOW_FLOOR`,
`MACHINE_DISK_BELOW_FLOOR`, or `MACHINE_COLD_START_EXCEEDED`, make the declared host capacity or
measured startup behavior satisfy its stated floor or limit, or deliberately revise the
declaration. `DISK_BUDGET_EXCEEDED` requires freeing space
or revising the declared budget. `DIRECTORY_GRANTS_UNAVAILABLE` requires restoring the declared
grants. `MOUNT_POSTURE_UNAVAILABLE` and `MOUNT_MATERIALIZATION_UNAVAILABLE` require valid mount
evidence. `REGISTRY_AUTH_UNAVAILABLE` requires authenticated registry evidence. `STATE_UNSEEDED`
requires the declared initial seed; do not erase history to make the stack appear new.

Generated services can declare `resources.memory_mb`, `resources.cpus`, and
`resources.provenance`. The generated Compose service applies these as `mem_limit` and `cpus`.
Use `browser.resources` with the same fields, `environment.generated` and a declared `browser.endpoint` to bound the
generated browser runner. Minimum memory and CPU values are in the
[configuration reference](configuration-reference.md). Choose
ceilings from the product's measured needs and the laptop's allocation; cockpit supplies no
invented limits. Environment decisions report declared ceilings or their absence. The machine
floor remains a minimum capacity check, separate from these per-service ceilings.

### Generated, dependency, data, and vendor evidence

For generated declaration or input failures (`GENERATED_DECLARATION_MISSING`,
`GENERATED_DECLARATION_INVALID`, `GENERATED_INPUT_INVALID`, `GENERATED_TEMPLATE_INVALID`,
`GENERATED_COMPOSE_INVALID`, `GENERATED_PERSONA_INVALID`,
`GENERATED_PERSONA_SOURCE_UNAVAILABLE`, and `GENERATED_EXECUTABLE_UNAVAILABLE`), correct the
declared generated contract, authenticated persona source, or resolved local executable. Run
`cockpit check --config <file>` before publishing intended bytes.

For generated ownership and path failures (`GENERATED_OWNERSHIP_MISSING`,
`GENERATED_OWNERSHIP_INVALID`, `GENERATED_OWNERSHIP_DRIFT`, `GENERATED_PATH_DUPLICATE`,
`GENERATED_PATH_UNSAFE`, `GENERATED_PATH_UNOWNED`, `GENERATED_STALE_ARTIFACT`, and
`GENERATED_STALE_ARTIFACT_DRIFT`), inspect the named path and prior ownership manifest. Preserve
changed bytes; do not delete them or adopt them manually as generated output.
`GENERATED_STALE_APPROVAL_REQUIRED` means the dry run identified a stale removal but the apply
lacks independent approval bound to that exact request; use `sync --interactive` from a terminal
outside CI after reviewing every removal. `GENERATED_STALE_APPROVAL_INVALID` means
the request could not be constructed safely. Neither result authorizes manual deletion.
Ownership metadata cannot claim configuration or authenticated source inputs, including aliases
to the same file. Restore trusted ownership metadata before retrying an input-overlap refusal.

For byte or publication failures (`GENERATED_ARTIFACT_MISSING`, `GENERATED_ARTIFACT_DRIFT`,
`GENERATED_SOURCE_CHANGED`, `GENERATED_PUBLICATION_FAILED`, `GENERATED_COMPENSATION_FAILED`,
`GENERATED_RENDER_UNAUTHENTICATED`, `GENERATED_INSPECTION_INVALID`, and
`GENERATED_ENVIRONMENT_UNAVAILABLE`), use `check` to identify current drift. Use `sync` only after
reviewing the declaration and its sources. A publication or compensation failure retains named
recovery inputs; inspect them before retrying. See the complete
[`GENERATED_ARTIFACT_DRIFT` recovery chain](troubleshooting.md#generated_artifact_drift).

For decision-log failures (`GENERATED_DECISION_COVERAGE`, `GENERATED_DECISION_DUPLICATE`,
`GENERATED_DECISION_FUTURE`, `GENERATED_DECISION_STALE`, and
`GENERATED_DECISION_SENSITIVE`), correct the declaration and regenerate. Never insert credentials
or machine-local paths. Decision correctness remains `human_needed` after structural checks pass.

For dependency-runtime failures (`DEPENDENCY_RUNTIME_UNAVAILABLE`, `DEPENDENCY_RUNTIME_STALE`,
`DEPENDENCY_RUNTIME_UNMOUNTED`, and `DEPENDENCY_RUNTIME_INCOMPATIBLE`),
`INSTALL_STATE_UNHEALTHY`, or a related `EXECUTION_*` failure, restore the exact current
container and image identity, physical volume mount, supported architecture and ABI, and
same-mount load probe. Health commands remain read-only and never install dependencies.

`DATA_MODE_UNAVAILABLE`, `EXECUTION_PRECONDITION_CHANGED`, and `EXECUTION_STEP_FAILED` require
the selected declared data mode to finish, including any restore reservation, before current
read-only mode and fixture-volume probes are rerun. Use the durable applied, attempted, and
not-applied IDs; do not infer an applied step from the plan.

For vendor failures (`EXTERNAL_DEPENDENCY_DECLARATION_INVALID`,
`EXTERNAL_DEPENDENCY_TEMPLATE_MISMATCH`, `EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE`,
`EXTERNAL_DEPENDENCY_EXPIRED`, `EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE`,
`EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE`, and `EXTERNAL_DEPENDENCIES_UNAVAILABLE`), repair the
named declaration, template pin, shadow, or current service evidence and rerun every declared
verifier against the current stack. Expired, missing, product-owned, or unmeasured evidence stays
nonpassing.

Surface, projection, MCP, skill, selftest, restriction, and upgrade diagnostics are grouped with
their bounded remedies in [Harness surface failures](troubleshooting.md#harness-surface-failures).

## Where the decisions live

| Concern | Owner |
|---|---|
| Config and checkout observation | `packages/cockpit/src/config/` and `packages/cockpit/src/environment/setup-observation.ts` |
| Claims, ports, runtime, logs, and evidence | Their modules under `packages/cockpit/src/environment/` |
| Generated rendering and inspection | `packages/cockpit/src/environment/generated-stack.ts` |
| Generated publication and recovery | `packages/cockpit/src/environment/generated-application.ts` |
| Public `sync` and `check` adapter | `packages/cockpit/src/generated-environment/command.ts` |
| Surface merge, capability output, and ownership | `packages/cockpit/src/surfaces/` |
| Configured selftest evidence and approval | `packages/cockpit/src/environment/selftest-application.ts`; `packages/cockpit/src/selftest/command.ts` forwards |
| Reset, baseline, and sync operator admission | `packages/cockpit/src/environment/operator-application.ts` |
| Configured upgrade evidence preparation | `packages/cockpit/src/environment/upgrade-application.ts`; `packages/cockpit/src/upgrade/command.ts` forwards |
| Read-only upgrade plan | `packages/cockpit/src/upgrade/command.ts` |
| Dependency runtime and same-mount load | `packages/cockpit/src/environment/dependency-runtime.ts` |
| Data execution and durable readback | `packages/cockpit/src/environment/data-plane.ts` |
| Vendor planning and verification | `packages/cockpit/src/environment/external-dependencies.ts` |
| Generated lifecycle production wiring | `packages/cockpit/src/environment/lifecycle-composition.ts` |
| Command order and postchecks | `packages/cockpit/src/environment/application.ts` |
| Production observation construction | `packages/cockpit/src/environment/destructive-composition.ts`, `packages/cockpit/src/environment/health-composition.ts`, `packages/cockpit/src/environment/lifecycle-composition.ts`, and `packages/cockpit/src/environment/read-composition.ts` |
| Process execution | `packages/cockpit/src/environment-exec/execute.ts` |
| CLI flags and output | `packages/cockpit/src/command-table.ts`, `packages/cockpit/src/cli.ts`, and `packages/cockpit/src/diagnostics.ts` |

The TypeScript owners decide what to inspect or change. The executor runs only their issued
steps. The CLI binds those owners and renders their outcomes; it does not decide lifecycle or
destructive policy.
