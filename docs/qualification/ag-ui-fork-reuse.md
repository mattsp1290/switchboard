# AG-UI fork reuse

Switchboard must consume the owned [combined SDK PR 49](https://github.com/mattsp1290/ag-ui/pull/49) without losing its native requirements.
The [fork manifest](../protocol/ag-ui-fork.json) records immutable source readiness.
It does not change installed dependencies or establish runtime adoption.

## Source identity

The selected combined source is `ed2c1d5b63299d3f08676a1418cc2640bbe55fd1`.
Its tree is `4dd1b37d5fd8486b022827c102f2b53ea2bfdfc8`.
The manifest pins six package manifests, public entries, native translators, protocol inputs, license notices, and the workspace lockfile.
These are source hashes. Package archives require their own integrity pins and installed-consumer checks.

The combined commit includes the following source revisions.

| Source PR | Owned branch | Included revision |
| --- | --- | --- |
| [Codex 3360](https://github.com/ag-ui-protocol/ag-ui/pull/3360) | `codex/codex-sdk-integration` | `cdeb18106f7061b351460248a1f67c746ef9ce27` |
| [Pi 3357](https://github.com/ag-ui-protocol/ag-ui/pull/3357) | `codex/pi-typescript-integration` | `ddc3279ad40b16b1e124c23738caf2eb1bc419b8` |

Observed Pi head `dd5587a571dabb268430c66920bcee9bd2745212` adds a CI dependency-install fix beyond the included revision.
That commit is absent from the selected combined source.
[Draft sync PR 50](https://github.com/mattsp1290/ag-ui/pull/50) proposes bringing that source change into the combined branch.
That proposal is not a merged source update.
Observed branch heads are historical observations, separate from included ancestry.
The verifier does not resolve moving refs or fetch new commits.

## Reproduce source verification

Run the local Git-object check with an AG-UI repository containing the pinned commits.

```sh
node scripts/verify-agui-fork-source.mjs /absolute/path/to/ag-ui
```

The command checks exact commit and tree identities, source ancestry, file digests, package versions, license labels, and selected public source exports.
It also checks that the schema, fixture manifest, and root license match the historical canonical pins.
It reads committed Git objects, so a dirty AG-UI checkout cannot substitute uncommitted files.
It performs no install, SDK import, native execution, or network access.
Its success message explicitly describes source verification only.

## Reuse boundaries

`@ag-ui/core@1.0.4` is protocol support shared by the fork and Switchboard's current dependency.
Matching version labels do not prove that an installed package came from the fork.
The existing [canonical manifest](../protocol/ag-ui-pin.json) and historical fixture results retain their original provenance.

The Codex package wraps official SDK and CLI `0.167.1`.
Switchboard instead selects public app-server `0.169.0` in [Codex selection](codex-selection.md).
The SDK translator consumes SDK `ThreadEvent` snapshots, not app-server JSON-RPC notifications.
Exporting that translator alone would not preserve discovery, approval requests, or native call recovery.
The Codex adapter also cancels its owned work when its observable is unsubscribed.
Switchboard observer disposal must remain separate from authoritative work cancellation.

Pi already exports `createTranslator` and `toAguiMessages`.
Those functions can project native events without owning a native session.
A consumer must choose one projection owner for each event family and run lifecycle.
Feeding their AG-UI output back through Switchboard's native-fact projector would duplicate translation.
The current Pi translator omits reasoning and image content.
Its example server does not establish native session discovery, approval workflows, or persistent continuation.
These gaps remain qualification requirements, rather than permission to reduce native scope.

## Delivery gates and ownership

`agentui-wtdo` owns portable delivery and installed qualification of the six frozen fork archives.
`switchboard-193h` owns Switchboard's actual installed core adoption from that delivery.
Switchboard must consume that delivery with exact artifact digests and confirm its actual installed package resolution.
Its existing installed projection suite must run against the delivered core bytes before claiming fork adoption.
Adding unused adapter dependencies or recording this source manifest does not satisfy that gate.

`switchboard-rlsx` retains Pi selection and reuse qualification.
`switchboard-mebb` retains complete Codex adapter integration.
`switchboard-3g7b` retains mappings across native adapters.
Existing native compiler, import confinement, discovery, authentication, and direct and LiteLLM gates retain their owners and status.
The open AG-UI request `ag-ui-r-6amp` retains host-tool and same-call cold-recovery requirements.
Its negative SDK recovery evidence is distinct from app-server qualification.

Reusable AG-UI changes belong on the applicable source branch before inclusion in PR 49.
Independent subagents must argue upstream ownership and native compatibility before those code changes.
Switchboard retains host-facing native session, authorization, observer, and routing responsibilities.
