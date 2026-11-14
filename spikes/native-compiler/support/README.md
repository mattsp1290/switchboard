# Installed compiler and package proof

Run from the checkout with Node 24.22.3 and an explicit npm 11.19.1 CLI.

```sh
/absolute/node spikes/native-compiler/support/run.mjs /absolute/npm-cli.js
```

The command creates a fresh external directory and prints its evidence path. It retains command results, complete diagnostics, compiler closures, package metadata, artifact hashes, realized consumer locks, and a summary. No private scratch state or existing checkout installation supplies the compiler. The root manifest and unchanged lock install TypeScript 7.0.2 and Node declarations 24.19.2 with optional platform compiler packages.

Consumer locks start with exact registry records from that tool lock and hashed local tarballs. npm validates each complete temporary lock offline, the verifier compares every registry version/source/integrity tuple, and `npm ci` installs it offline. npm uses empty explicit user/global configs, a fresh cache, and an environment allowlist. It receives no home variable or credentials. No dependency lock is added to this checkout.

The inert compiled package reaches a real relative `.js` helper and a separate installed third-party declaration. Both strict NodeNext/ES2022 policies pass, with DOM absent and explicitly present. The root compiler flags remain unchanged and declaration checking stays enabled.

Controls reject owned-source and third-party declaration errors by complete file/line/code sets. Extra errors, unrelated errors, wrong locations/codes, unexpected output, exit status, signal, and timeout fail the diagnostic gate. A compiling transitive foreign declaration fails the closure allowlist. Private source/output imports fail TypeScript resolution. A malformed emitted relative import fails the static emitted-file check. Each mutation restores the positive fixture.

`compiler.mjs` exports bounded `command`, `successful`, `compilerPolicy`, `exactDiagnostics`, `assertClosure`, `assertEmitted`, `compilerLibraryRoots`, and `nodeDeclarationRoots`. Closure inputs are absolute compiler file paths. Every reachable file must be an exact admitted source file or a declaration inside an explicitly admitted real directory. Symlink paths and foreign files fail. Emitted inspection follows quoted literal relative ESM imports, re-exports, and dynamic imports from public entries. It rejects commented import syntax and opaque dynamic expressions that this static check cannot inspect. It does not load modules.

`package.mjs` exports `npmEnvironment`, `npmCommand`, `installTools`, `packPackage`, and `installPackages`. A packed artifact carries its absolute tarball path, SHA-256, npm metadata, manifest, and export map. These small operations accept ordinary project paths and manifests; they do not define a package-building language.

The parent installed-core verifier calls `assertCoreIsolation(project, closure, { allowedRoots, allowedFiles })`. Use compiler library roots, Node declaration roots and their declared dependency roots, installed core declarations, and exact consumer source paths. The helper rejects installed manifests, resolvable package names, and compiler references for Claude, Anthropic, Pi, Codex, and MCP. The same helper rejects a deliberately installed inert package using a native package name, its actual compiler reference, and a foreign transitive declaration. The parent retains its independent AG-UI and runtime checks.

This unit proves compiler/package mechanisms only. It does not import any SDK, invoke providers, qualify native SDK types, or establish runtime confinement. Native-name control packages contain only inert local declarations and JavaScript. Unit B owns confined installed imports, including loader behavior. Engine proofs depend on that separate acceptance.

