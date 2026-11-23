# Cursor text runtime control audit

Status: candidate stopped at WP1. `createCursorTextRuntime` is not implemented or qualified.

The [implementation plan](../../.agents/plans/cursor-tool-free-text/01-sdk-contract.md)
requires explicit empty registries to override restored state. Its stop condition is:
"If restored tools, registries, settings or host context override explicit controls, stop the candidate."

## Missing control in SDK 1.4.2

The installed `@cursor/sdk@1.4.2` cannot clear stored custom subagents on resume
through the planned `agents: {}` field. The SDK's bundled
`src/agent/subagent-conversion.ts` returns `undefined` for an empty agents map.
`CursorAgentPlatform.resumeAgent` then uses a nullish fallback to stored
`metadata.customSubagents`. The resumed handle carries those definitions in
`options.customSubagents`. `getExecutor()` forwards them through `Ar(options)`
to `platform.acquireLocalExecutor()`.

The relevant installed source is `node_modules/@cursor/sdk/dist/esm/index.js`.
Its SHA-256 is
`bbaa5f9f0856701126a285b7cc5b418cf4a8eefa01164513e431b0a2d1b7d1d1`.
The source is minified. These searchable anchors identify the two decisions:

```js
const r = Object.entries(t);
if (0 === r.length) return;
```

```js
i = (0, Br.DB)(n.agents) ?? function(t) {
	const r = t[zr]; // zr = "customSubagents"
	// Valid stored definitions are returned here.
}(e.metadata)
```

This is a registry precedence failure. It does not establish that a subagent
executes when `tools: []` is present. The empty tools allowlist and empty
subagent registry are separate requirements in this plan.

The plan also requires an experiment with a generic-created session, even
though hosts must provide only same-contract sessions during normal text
resume. That host precondition does not waive the experiment's stop condition.

## Offline evidence

The experiment used a scratch copy of source commit
`cccb75a4531cab627a892995d8c2bc9946a78025`, with an audit case appended to
`tests/native-isolated/cursor-runtime.native.mjs`. Production source and the
installed SDK were unchanged. Host build tools were Node `24.22.3` and npm
`11.19.1`.

The case called the real SDK's `CursorAgentPlatform.createAgent` with one
sentinel subagent and an in-memory store, then called `resumeAgent` with the
planned empty registries, `tools: []`, and an `emptyFs()` tree. It inspected
the real resumed handle's internal resolved options. Those options contained
the persisted sentinel under `customSubagents`, retained an empty
`allowedProtoTools`, and retained the supplied tree. The input agents map
remained empty. No `send`, executor acquisition, inference, or checkpoint IO
was attempted. This is a narrow registry-precedence probe, not a full saved
conversation or deployment qualification.

Command in the scratch checkout:

```sh
PATH=/Users/punk1290/.nvm/versions/node/v24.22.3/bin:$PATH npm run test:native-isolated
```

The runner built the package successfully and ran its pinned Linux aarch64
container with network disabled, a read-only root, and synthetic decoys.
All three isolation controls were rejected as expected. The Cursor suite,
including the audit case, passed 19 tests with zero trace violations.
Codex and both Pi suites also passed. The overall command exited 1 because
the unchanged Claude suite failed `runtime shutdown reaps stubborn-init children`
with `ENOENT` for its fixture's `observed.json`. That suite also reported one
trace violation. This run is not a passing repository gate.

Local evidence is preserved at
`/tmp/switchboard-cursor-text-audit.HLYRj5/`: `probe-fragment.mjs`,
`sdk-source-excerpts.json`, `source-hashes.json`, `native-audit.log`, and
the scratch checkout. The original plan's `research/verify-plan.py` passed
its source and dependency hash checks. The full implementation gate sequence
was not run because this control audit stopped the candidate.

## Recovery boundary

The missing SDK behavior is an explicit empty custom-subagent override during
resume that does not fall back to stored definitions. A revised candidate needs
that behavior and a fresh control audit against its exact SDK artifact.

The user subsequently authorized SDK upgrades and prohibited SDK modifications.
A direct public npm registry check on November 22, 2026 returned `latest: 1.4.2`.
The complete published version list contained no newer release or prerelease.
The `next` tag pointed to the older `1.1.0-beta.0`. There is no published upgrade
to test as a replacement for the failing SDK.

The registry check used the pinned npm toolchain:

```sh
npm view @cursor/sdk dist-tags versions time.modified --json --registry=https://registry.npmjs.org --prefer-online
npm view @cursor/sdk@latest version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org --prefer-online
```

The version-list response is saved as `published-sdk-versions.json` in the local
evidence directory. The installed lockfile and audited SDK source hashes still
match the original probe. The public `AgentOptions` declaration has `agents`
but no `customSubagents` clearing override.

The upgrade authorization does not permit SDK patching, dependence on private
SDK fields, removal of resume, transcript or metadata rewriting, or weaker
acceptance criteria. Further implementation requires a published SDK with the
missing behavior, or an explicit revision of the contract.

The remaining control audit, runtime boundary, lifecycle changes, package tests,
candidate artifact, and Crew qualification gates have not passed. There is no
delivery commit, merged feature, or qualified package. The review gauntlet has
not started because the implementation prerequisite failed.
