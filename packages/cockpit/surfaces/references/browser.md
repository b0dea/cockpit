# Browser access and evidence

<!-- cockpit:verified version=0.0.0 -->

The rendered browser skill records, for each harness and version, the test date, the transport
spelling, and the declaration strength. Older tests seed the declarations. Whether the tool can be
called today stays `human_needed` until a person records a harmless call and a deliberately broken
control that the harness finds, using the current executable. An unsupported version or transport is
`unavailable` and emits no transport control. A declaration, a synthetic record, and a passing
source test each show something different; none shows that a real browser call worked.

Use the shared headless connection for the configured browser and the current runtime setup. The
pinned MCP image connects to the checking proxy endpoint. The optional CLI comes only from the exact
`@playwright/test` package named in the project's lock file, after cockpit checks the installed
manifest, the entry-point bytes and the npm lock bytes. Other lock formats currently make this
transport unavailable here. Never substitute a standalone CLI package. Prefer the CLI, when it is
eligible, for work that depends on identity or runs concurrently. Use a headed browser only as a
separate debugger.

For real sign-in, use mode-600 saved state minted from seeded users and the declared serialized or
per-worker policy. Sign in through a channel that keeps credentials out of transcripts. Keep
credentials, state contents, page content and production data out of transcripts and tracked
files. With bypassed authentication, sign-in and persona selection do not apply. With hostname
addressing a local browser or the headed debugger needs resolver rules; with port addressing it
does not.

A generated runner's browser runs in a container but opens the same URLs a person opens: the
commands connect with the declared network exposure (default `<loopback>`), so requests for
`127.0.0.1`, `localhost` and `.localhost` names travel back through the command's own process on
the host. An origin outside that exposure is refused before the browser starts. For that runner,
resolver rules only restate what the host resolver does for `.localhost` names, and an `https`
origin needs the development CA built into the runner image. A refusal that says nothing answered
at a URL is the stack, not the product: check `doctor` before reporting it.

Approving an MCP server enables it; letting its browser tools run without prompts is a separate
decision. Only isolated empty or seeded data with no route to production can be eligible. Restored
data, shared data and servers that reach production never qualify. The tested Codex transport needs
per-server `default_tools_approval_mode = "approve"`; when a server is not eligible, that setting is
omitted. Other approval controls that have not been tested are omitted. No browser setting changes
a guard decision or allows its own launch.

An independent grader keeps its browser tools. Read-only restrictions on files concern repository
files. Driving a browser can change product state, so keeping product state untouched is
instructed, not enforced. Do not narrow the grader's tool access to make files safer.

For a native paired probe, use the rendered tool invocation against `about:blank`, or the pinned
test package's remote `cli attach`, `goto about:blank`, and `close` commands. Place a deliberately
malformed declaration beside the candidate and keep the bytes of both. Check that the harness names
and rejects the broken file; silence does not show that it was discovered. Record the current
executable and version, the package identity, the version and help command results, the rendered
bytes, the exact invocation, what you observed, the timeout and output limits, and a readback after
cleanup. MCP records note the native config loader and the installed bytes; CLI records note that
the harness ran a shell command and that the pinned CLI prepared its config, without inventing a
harness config flag. Tie the reset and the filesystem readback to the cockpit directory in use, after
both observations are done. No cockpit command reads or checks this record, and none changes a
transport from `human_needed`: a person keeps it and decides whether it supports the claim.

Every transport root comes from the current runtime's reset inventory, including the sign-in and
debugger roots. After recording fixture files for every root, replay the public reset and confirm the
files are gone while the unregistered negative control remains. Reject the negative control as
unregistered. A cleanup flag in the output is not proof about the filesystem. Do not run any native
probe or accept its result until a person who is allowed to run them does so.

CLI packaging and remote-session syntax are documented in the upstream
[package manifest](https://github.com/microsoft/playwright/blob/main/packages/playwright-test/package.json)
and [CLI dispatcher](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/cli/program.ts),
with [remote command handling](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/cli-client/program.ts).
These references describe syntax; the installed pinned package is what actually runs.
