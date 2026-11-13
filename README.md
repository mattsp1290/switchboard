# Switchboard

Switchboard is a Node-hosted TypeScript library for native agent interfaces and adapters.
This foundation contains one private ESM package, `@mattsp1290/switchboard@0.0.0`.
Its root module exports adapter registration, identity, capability, outcome, and cleanup types.
Claude, Codex, Pi, and AG-UI integrations are future work.

Use Node 24.22.3 and npm 11.19.1. The package supports Node `>=24.22.3 <25`.
Development dependencies are pinned TypeScript 7.0.2 and Oxlint 1.93.0. There are no runtime dependencies.

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
It checks the empty runtime namespace, public contract types, blocked private imports, and package contents.
Type fixtures compile against the installed tarball and check capability narrowing, third-party registration, and rejected misuse.
The script removes its temporary files on success or failure.
Run `npm run build` to compile separately. The build removes `dist` before compilation. `npm run clean` removes the local build.

GitHub Actions runs the same checks on Ubuntu 24.04 with Node 24.22.3 and npm 11.19.1.
The workflow uses `npm ci`, immutable action commits, and read-only repository access.

The intended import is `import type { AdapterRegistration, Capability } from '@mattsp1290/switchboard'`.
Only the root entry exists. Native tools and credentials are unnecessary for this foundation check.
No native integration or direct or LiteLLM route is qualified by this package check.

[Architecture boundaries](docs/architecture/boundaries.md) records host responsibilities, source ownership, and native prerequisite evidence.
The existing [MIT license](LICENSE) covers Switchboard.
