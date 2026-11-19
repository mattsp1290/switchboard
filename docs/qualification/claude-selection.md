# Claude host adapter selection

Selection date is 2026-11-19, on main `f0fd03d`. The host adapter uses the public root entry of `@anthropic-ai/claude-agent-sdk@0.3.323`, the same pin as the text adapter. The text adapter in `adapters/claude/` stays unchanged.

The root project compiles with `skipLibCheck` off, `lib` `ES2022`, and `@types/node` `24.19.2`. Importing `query` from that SDK fails in `@modelcontextprotocol/sdk` `dist/esm/shared/transport.d.ts` with TS2304, `Cannot find name 'HeadersInit'`. The same failure is the named control in `tests/adapters/claude-host/declarations.test.mjs`. No other MCP pin was selected. The SDK stays a peer at `0.3.323`.

`adapters/claude-host/` is a separate TypeScript project with `skipLibCheck` so it can compile that import. Its emitted declarations do not name `@anthropic-ai`. `./host/claude` is not an export until the session adapter exists. Session files, host tools, and the provider route remain later slices of this package.

Probe A5 held: one deferred host tool call resumes in a fresh process with one result for the original identifier. Probe A6 held for one deferred call beside an allowed or denied sibling, and failed for two deferred calls in one message: only the second resumes. Those probes are recorded in `docs/qualification/host-tool-probes.md`. This package does not qualify a live provider, and it does not pass a subscription credential through.
