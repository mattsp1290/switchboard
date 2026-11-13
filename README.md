# Switchboard

Switchboard is a Node-hosted TypeScript library for native agent interfaces and adapters.
This foundation contains one private ESM package, `@mattsp1290/switchboard@0.0.0`.
Its root module exports no application API yet.
Core contracts, Claude, Codex, Pi, and AG-UI integrations are future work.

Use Node 24.22.3 and npm 11.19.1. The package supports Node `>=24.22.3 <25`.
TypeScript 7.0.2 is the only development dependency. There are no runtime dependencies.

Install and verify the foundation with these commands:

```sh
npm ci
npm run check
npm run build
npm run verify:package
```

`build` removes `dist` before compilation. `verify:package` rebuilds, packs, and installs the tarball in a temporary consumer.
It checks the empty runtime namespace, TypeScript declarations, blocked private imports, and package contents.
The script removes its temporary files on success or failure. `npm run clean` removes the local build.

The intended import is `import * as switchboard from '@mattsp1290/switchboard'`.
Only the root entry exists. Native tools and credentials are unnecessary for this foundation check.
No native integration or direct or LiteLLM route is qualified by this package check.

[Architecture boundaries](docs/architecture/boundaries.md) records host responsibilities, source ownership, and native prerequisite evidence.
The existing [MIT license](LICENSE) covers Switchboard.
