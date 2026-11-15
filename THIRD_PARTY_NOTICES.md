# Selected Codex binding

`src/adapters/codex/protocol/RequestId.ts` is copied without changes from OpenAI Codex CLI `0.169.0`.
The packed artifact contains its compiled forms, `dist/adapters/codex/protocol/RequestId.js` and `dist/adapters/codex/protocol/RequestId.d.ts`. No package export reaches those private paths.
The root MIT package metadata describes Switchboard's original code. This copied component remains Apache-2.0 under the shipped license and notice. Task `bzn9` owns reconciliation of aggregate SPDX metadata before release.
The selected source revision is `d32063f96c2dff1dc96af839b3952abb6acfeda4`.
The binding's consumed bytes equal its source bytes. It has no imports and receives zero import rewrites.

| Artifact | Immutable source | SHA-256 |
| --- | --- | --- |
| RequestId | [RequestId.ts](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/codex-rs/app-server-protocol/schema/typescript/RequestId.ts) | `beeb38dfd0b050b171141bd66d51663786a50a81cbe904ba9b006289a101fd39` |
| Apache-2.0 license | [LICENSE](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/LICENSE) | `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc` |
| Attribution notice | [NOTICE](https://github.com/openai/codex/blob/d32063f96c2dff1dc96af839b3952abb6acfeda4/NOTICE) | `9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915` |

The complete upstream license and notice are preserved in `licenses/codex-APACHE-2.0.txt` and `licenses/codex-NOTICE.txt`.
The qualifier uses `spikes/codex-native/protocol-bindings.mjs` for its generated tree. Only validated module specifiers change.
Its result records deterministic SHA-256 hashes of sorted `[path, source]` pairs before and after transformation.
Native generator parity compares the pinned `0.169.0` binary's `generate-ts` output against the committed leaf. It does not compare against the linked blob. The existing native CI job must establish that parity. A mismatch records both hashes and raw generated source bounded to 512 JSON-encoded UTF-8 bytes, then fails without header normalization.

# OpenTelemetry GenAI schema fixtures

The development-only files `tests/observability/fixtures/gen-ai-input-messages.json` and `gen-ai-output-messages.json` are copied from OpenTelemetry semantic conventions v1.37.0.
Their exact source URLs and SHA-256 digests are recorded in `docs/observability/qualification-pin.json`.
The Apache-2.0 license is preserved in `tests/observability/fixtures/UPSTREAM-LICENSE`.
These schema fixtures do not ship in the package tarball.
