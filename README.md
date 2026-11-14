# Switchboard

Switchboard is a Node-hosted TypeScript library for native agent interfaces and adapters.
This foundation contains one private ESM package, `@mattsp1290/switchboard@0.0.0`.
Its root module exports adapter contracts, native session envelopes, validation helpers, and bounded event streams.
The optional `./agui` entry projects observed facts into pinned AG-UI 1.0 output. Claude, Codex, and Pi adapters remain unqualified.

Use Node 24.22.3 and npm 11.19.1. The package supports Node `>=24.22.3 <25`.
Development dependencies pin TypeScript 7.0.2, Oxlint 1.93.0, and `@types/node` 24.19.2. There are no runtime dependencies.

Install and verify the foundation with these commands:

```sh
npm ci
npm run lint
npm run check
npm test
```

`lint` checks JavaScript and TypeScript with Oxlint. `check` runs the strict TypeScript compiler without emitting files.
`test` runs Node's built-in test runner over `tests/**/*.test.mjs`, including nested test directories.
The package test runs `verify:package`, which rebuilds, packs, and installs the tarball in a temporary consumer.
It checks public contract types, installed runtime helpers, blocked private imports, and package contents.
The `tests/core/*.test.ts` fixtures compile against the installed tarball and are never executed.
The `tests/core/*.consumer.mjs` fixtures run with `node --test` inside that installed consumer.
Source and consumer compilation use ES2022 and Node declarations without DOM libraries.
The script removes its temporary files on success or failure.
Run `npm run build` to compile separately. The build removes `dist` before compilation. `npm run clean` removes the local build.

GitHub Actions runs the same checks on Ubuntu 24.04 with Node 24.22.3 and npm 11.19.1.
The workflow uses `npm ci`, immutable action commits, and read-only repository access.
It also runs `npm run verify:agui` against checksum-pinned canonical schema fixtures and published Python and TypeScript SDKs.
That repository development check requires uv 0.11.3, Python 3.13.12, and initial registry/GitHub access.
Its SDK environments are temporary. It adds no package dependencies or native qualification claims.
The protocol matrix, exact per-definition dispositions, and validation differences are recorded under `docs/protocol/`.
Installed verification requires actual projection output for all 28 explicit event kinds and five child terminal variants.
Three canonical chunk kinds normalize to explicit stream events. Input and capability declarations do not create output events.

The intended import is `import type { AdapterRegistration, Capability } from '@mattsp1290/switchboard'`.
The separate `@mattsp1290/switchboard/agui` entry requires the exact optional peer `@ag-ui/core@1.0.4`.
Development and the installed AG-UI consumer use the immutable core archive from owned [AG-UI PR 49](https://github.com/mattsp1290/ag-ui/pull/49).
The [fork reuse record](docs/qualification/ag-ui-fork-reuse.md) pins its delivery and separates core adoption from native adapter qualification.
Native tools and credentials are unnecessary for this foundation check.
No native integration or direct or LiteLLM route is qualified by this package check.

[Architecture boundaries](docs/architecture/boundaries.md) records host responsibilities, source ownership, and native prerequisite evidence.
The existing [MIT license](LICENSE) covers Switchboard.

TypeScript consumers need `@types/node` in their development dependencies because public cancellation contracts use `AbortSignal`.
The installed consumer verifies `@types/node` 24.19.2 with `lib: ["ES2022"]` and `types: ["node"]`.

`parseSessionReference` checks persisted input against an expected native binding.
`parseCheckpointReference` also checks the exact native session token.
Both return copied, frozen envelopes. These checks do not authenticate native tokens or authorize access.
`validateSessionDiscoveryBounds` validates result, examined-entry, and time budgets.
Every `SessionDiscoveryPage` requires `diagnostics`, including `[]` when no failure was observed.
Sessions and unidentified `file-inspection-failed` observations survive complete, truncated, and cancelled enumeration.
Each diagnostic has an opaque, call-local `discovery-file` subject. Its token grants no inspect or resume access.
Unidentified failures do not imply corruption or increment either skipped count.
`complete` means the adapter exhausted its qualified authorized enumeration, not that every candidate succeeded or all native history is valid.
Native discovery, inspection, and resume require later adapter implementations and qualification.

`createEventStream<T>({ maxObservers, capacity })` provides asynchronous FIFO delivery with one active callback per observer.
`capacity` counts queued events and the active callback. `maxObservers` includes retired subscriptions until their callbacks settle.
Publication returns immediately and reports overflowing observers as disconnected. Other observers continue independently.
`Subscription.ended` reports detachment. Consumer code may still run after disposal, abort, or close.
Payloads are borrowed references. The host owns payload immutability, payload size limits, and durable replay.
`EventObserver<T>` exposes subscription through a compile-time API restriction. It is not an authorization boundary.
Disposal and close never cancel native work. See [event delivery boundaries](docs/architecture/boundaries.md#event-delivery) for terminal outcomes and admission rules.
