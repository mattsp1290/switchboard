# AG-UI protocol qualification

Switchboard selects protocol `1.0`, TypeScript `@ag-ui/core@1.0.4`, and Python `ag-ui-protocol==1.0.0` for its planned AG-UI boundary.
This qualifies the protocol inventory and SDK comparison. Native mappings and consumer replay behavior remain unimplemented and unqualified.

[The release manifest](ag-ui-pin.json) pins download URLs, artifact hashes, verification tools, source hashes, category classifications, and fixture owners.
[The matrix](ag-ui-matrix.tsv) classifies every canonical definition and lists its event discriminator, inherited wire fields, required fields, Python defaults, and Python public export status.
All rows inherit the manifest's protocol representation, planned mapping, native qualification, and fixture ownership classifications.
The comparison covers 31 events and 98 definitions. All six Claude, Codex, and Pi direct and LiteLLM combinations remain `unqualified`.

The immutable sources are the [canonical schema](https://github.com/ag-ui-protocol/ag-ui/blob/0fc064bb2647fc0bce4fc795af33b5551ac03f88/spec/1.0/schema.json), [TypeScript declarations](https://github.com/ag-ui-protocol/ag-ui/blob/0fc064bb2647fc0bce4fc795af33b5551ac03f88/sdks/typescript/packages/core/src/generated/types.ts), and [Python models](https://github.com/ag-ui-protocol/ag-ui/blob/0fc064bb2647fc0bce4fc795af33b5551ac03f88/sdks/python/ag_ui/_generated/models.py).
The verifier checks published release artifacts against this schema. The source commit supplies evidence, not a moving release target.
The [npm tarball](https://registry.npmjs.org/@ag-ui/core/-/core-1.0.4.tgz) and [Python wheel](https://files.pythonhosted.org/packages/82/b0/850be4576e6443dc575daa54188d8136ae2b2eca3f19e098e7a088fc9ebc/ag_ui_protocol-1.0.0-py3-none-any.whl) have independent immutable digest pins.

## Mapping requirements by category

These requirements govern future mappings. Protocol representation does not establish native emission or implemented mapper support.
Each category owns the matrix rows with its name. Every category uses the schema fixture and test owners recorded in the manifest.
Native adapter qualification tasks own engine-specific mapping fixtures for both routes. Consumer contract tasks own host behavior fixtures.

| Category | Required mapping behavior |
| --- | --- |
| envelope | Preserve protocol version, attribution, identities, and metadata. Host IDs and native IDs remain distinct. |
| lifecycle | Preserve run and step boundaries. `RUN_ERROR` reports a run error, independently of transport rejection. |
| text | Support start, content, end, and chunk representations. Empty deltas are legal. Do not synthesize missing native content. |
| tools | Preserve calls, argument fragments, completion, results, and parent linkage. Call completion does not prove tool effects or approval delivery. |
| state | Represent snapshots and every JSON Patch operation. The host owns committed state, storage, and replay. |
| messages | Preserve all seven roles and conversation snapshots. A snapshot is observable protocol data, not a durable consumer database. |
| activity | Preserve activity type, structured content, replacement flag, and patches. Consumer reducers own materialized activity views. |
| extensions | Carry only authorized, redacted native details through `RAW`, `CUSTOM`, metadata, or `rawEvent`. Label extension namespaces and versions. |
| reasoning | Preserve exposed spans, messages, chunks, and encrypted values as opaque data. Never manufacture hidden reasoning or decrypt opaque values. |
| subagents | Preserve invocation IDs, parent attribution, start, success, suspension, and error. A subagent failure need not terminate the parent run. |
| outcomes | Preserve success with optional pending tool IDs, interrupt, and cancelled run outcomes. An absent run outcome means success. |
| interrupts | Preserve interrupt IDs, open reasons, tool linkage, response schema, expiry, attribution, and resolved or cancelled resume entries. |
| usage | Preserve reported provider, model, and token totals. Reasoning and cache counts are components, not additions to totals. Missing counts remain absent. |
| multimodal | Preserve text, image, audio, video, and document parts with data, URL, or provider file sources. Mapping grants no permission to fetch files. |
| request | Preserve run input, messages, state, tools, context, forwarded properties, and resume entries. Validate input against native capabilities before dispatch. |
| capabilities | Represent identity, transport, tools, output, state, multi-agent, reasoning, multimodal, execution, human interaction, and custom declarations. |

Capability omission means unknown. Explicit false means unsupported for that declared capability.
Switchboard also distinguishes configured unavailability from unsupported features. Qualification status remains separate from both.
A protocol category without native evidence stays unqualified. A qualified absence becomes unsupported with a reason, without fabricated events.
A configuration restriction becomes unavailable with a reason. Unknown availability never becomes an affirmative AG-UI capability flag.
All canonical event families belong to the protocol consumer contract. Native producers emit only facts their supported APIs expose.

`RUN_FINISHED` with an interrupt outcome ends this run segment and carries the interrupts needed by a later `RunAgentInput.resume`.
Subagent suspension refers to run-level interrupts and can omit its own interrupt IDs when a descendant interrupted.
These shapes do not establish native suspension, resumability, approval delivery, or host authorization.
A requested cancellation does not justify a confirmed cancelled outcome. Preserve uncertain native effects separately until evidence establishes termination.
Neither a cancelled outcome nor local operation IDs imply rollback, exactly-once effects, or permission to retry an ambiguous dispatch.

Crew or another host owns durable admission, committed projection, snapshots, reconnect cursors, replay, authorization, and multi-client synchronization.
Protocol transport and resumable capability declarations supply no implementations of those services in Switchboard.
Schema validation proves shape. It does not prove stream ordering, chunk assembly, native behavior, delivery confirmation, redaction, or consumer reducers.
The upstream [stream corpus](https://github.com/ag-ui-protocol/ag-ui/blob/0fc064bb2647fc0bce4fc795af33b5551ac03f88/spec/1.0/conformance/README.md) assigns those client semantics separately and records intentional client divergences.

## SDK validation differences

[The fixture index](../../tests/agui/fixtures/upstream.tsv) pins all 219 upstream schema payloads by raw SHA-256, with separate SDK acceptance expectations.
The verifier fetches their original bytes. No fixture payloads or upstream source tree are vendored.
The [MIT notice](../../tests/agui/fixtures/UPSTREAM-LICENSE) attributes the upstream inputs.
Both releases accept all 135 canonical valid fixtures. TypeScript accepts 8 of the 84 canonical invalid fixtures. Python accepts 22.
Both validators allow extra fields that the canonical closed shapes reject. Python also accepts optional nulls, coerces a boolean, and defaults a missing reasoning role.
Python defaults singleton discriminators, including `type`, `role`, and JSON Patch `op`. TypeScript keeps canonical requiredness.
TypeScript publicly exports all 98 definitions. Python exposes 86 through `ag_ui.core` and all 98 through its generated models.
The missing Python public names are attribution helpers, `TextMessageRole`, and JSON Patch types. Their shapes still participate in nested wire validation.
SDK convenience helpers and historical compatibility aliases are outside this inventory of normative protocol shapes.
The matrix records each Python default explicitly. The verifier tests every required-field omission, every union member, and every top-level enum value.
Python uses snake_case attributes with camelCase aliases and omits absent optional nulls on serialization. This check covers input validation, not serialization equivalence.
These differences are pinned observations, not permission for a Switchboard producer to emit invalid wire data. The canonical schema remains the strict wire shape authority.

## Verification and CI integration

Run `node scripts/verify-agui-matrix.mjs` from the repository. It downloads checksum-verified inputs and installs SDKs only in a temporary directory.
It compares published TypeScript declarations and both SDKs' field membership, requiredness, enum inventory, and fixture acceptance against the matrix and canonical schema.
It removes the temporary SDK directory after the check. It adds no runtime or development dependencies to Switchboard.

Use an Ubuntu 24.04 runner with the foundation's Node `24.22.3` and npm `11.19.1`, `uv 0.11.3`, and Python `3.13.12`.
The script selects Python `3.13.12` and installs `pydantic==2.11.7`, `zod@4.0.17`, and `ajv@8.17.1` in isolated verification environments.
Install Python `3.13.12` with uv before the gate. Registry and raw GitHub access are required on the first run.
Add `"verify:agui": "node scripts/verify-agui-matrix.mjs"` to package scripts and run `npm run verify:agui` in the Linux quality workflow.
Keep this gate separate from claims of live native qualification or macOS support.
`AGUI_ARTIFACT_CACHE` selects a persistent download cache. `AGUI_SOURCE_ROOT` selects an optional read-only upstream checkout. Both paths still receive digest checks.
The standalone verifier passed on macOS with Node `24.22.3`, npm `11.19.1`, uv `0.11.3`, and Python `3.13.12`. Ubuntu execution remains a CI obligation.
