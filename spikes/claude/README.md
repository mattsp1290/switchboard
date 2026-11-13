# Reproduce Claude selection evidence

This probe uses the real SDK with synthetic files and an in-memory stdio peer. It never launches Claude or calls a provider. A passing result does not qualify a live integration.

Use Node 24.22.3 and npm 11.19.1. From the repository root, run:

```sh
curl --fail --location --output /tmp/claude-0.3.323.tgz \
  https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.323.tgz
node spikes/claude/run.mjs /tmp/claude-0.3.323.tgz
```

`run.mjs` verifies the SHA-512 registry integrity before extraction, then verifies the SDK implementation and declaration SHA-256 hashes. It prints one JSON result with `evidence: "fixture-only"`. The subprocess has a 20-second deadline and a 1 MiB output limit. Temporary files are removed even on failure.

The SDK subprocess receives an explicit environment containing fixture configuration paths and nonessential-traffic suppression. It receives no inherited credentials or `NODE_OPTIONS`. The runner does not change `HOME` or `CODEX_HOME`. Node permissions restrict filesystem access to the fixture and probe, and deny subprocess spawning. The runner itself needs `tar` and launches Node, never the Claude binary.

The source review preceded execution. In the pinned `sdk.mjs`, `Wt` derives the config root from `CLAUDE_CONFIG_DIR`; `K5t`, `G5t`, and `j5t` dispatch public history calls to local readers or the supplied store. `ei` searches below that config root. `V5t` imports into the supplied store. `tnt` and `OD` create a process transport; its `spawnClaudeCodeProcess` branch replaces native spawning. The probe supplies a fake executable path, no remote transport, no SDK MCP server, and an `EventEmitter` with memory streams. No helper command is executed. Node permissions are defense in depth, not a claimed network sandbox. These selected paths contain no provider HTTP call.

To check public types, create a private directory and copy `package.json`, `types.ts`, and `tsconfig.json` there. Keep the resulting dependency lock with the qualification run evidence. The manifest pins direct dependencies; it is not a complete transitive lock.

```sh
scratch=$(mktemp -d)
cp spikes/claude/{package.json,types.ts,tsconfig.json} "$scratch/"
touch "$scratch/user.npmrc" "$scratch/global.npmrc"
cd "$scratch"
npm install --ignore-scripts --omit=optional --no-audit --no-fund \
  --userconfig="$scratch/user.npmrc" --globalconfig="$scratch/global.npmrc" \
  --cache="$scratch/npm-cache"
```

TypeScript 7 ships its compiler as a platform package. Install exactly one compiler package without installing Claude's optional binary. For Linux x64 CI, run:

```sh
npm install --no-save --ignore-scripts --omit=optional --no-audit --no-fund \
  --userconfig="$scratch/user.npmrc" --globalconfig="$scratch/global.npmrc" \
  --cache="$scratch/npm-cache" @typescript/typescript-linux-x64@7.0.2
node node_modules/typescript/bin/tsc -p tsconfig.json
```

Use `@typescript/typescript-darwin-arm64@7.0.2` on macOS arm64. The local configuration matches the source compiler gate, including `skipLibCheck: false`, strict NodeNext, ES2022, Node types, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`. It does not include DOM declarations. No TypeScript fixture code is executed.

The current pins **fail** this check with exit status 1:

```text
node_modules/@modelcontextprotocol/sdk/dist/esm/shared/transport.d.ts(7,51): error TS2304: Cannot find name 'HeadersInit'.
```

The SDK root declaration imports MCP's `McpServer`, which imports `Transport`. MCP 1.32.2 uses an undeclared global `HeadersInit`; Node types 24.19.2 define `Headers` and `RequestInit`, but no global `HeadersInit`. The exported alias in `undici-types` does not create a global. The [artifact manifest](sources.json) records static inspection of every published MCP pin in the SDK's `^1.29.0` peer range on the selection date. Each contains this declaration. Minimal `Options` imports through both the SDK root and `/core` also fail under the strict gate. No compatible pin or public SDK import fix was found that retains external-session APIs. Do not add DOM, enable `skipLibCheck`, or inject a global alias to report a pass. A corrected upstream declaration and a new exact-pin run are required before implementation selection passes.

The earlier `skipLibCheck` run established only selected consumer names and options. `types.ts` uses `Pick<Query, ...>` to check method existence; it does not exercise control arguments or native effects. It also cannot prove history error classification, writer coordination, or credential renewal boundaries.

The shared CI owner can add the runtime command as a separate Node 24.22.3 Linux job with the checksum-verified tarball cached by integrity. The type job needs npm 11.19.1 and the private installation above. Root exports, production dependencies, existing CI, and package publication are unchanged. Live qualification is a separate job requiring explicit host-owned credentials and disposable native state.
