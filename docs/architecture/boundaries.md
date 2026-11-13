# Switchboard boundaries

Switchboard supplies reusable interfaces and native adapters for a Node host.
The foundation currently supplies an empty root module and a package verification command.
It does not yet supply contracts, adapters, session discovery, or AG-UI mappings.
The package is private and has no runtime dependencies.

## Host ownership

Crew, AgentUI, or another consumer owns authorization policy, credential resolution, and durable command intent and outcomes.
The host also owns database storage, event replay, recovery scheduling, workflow retries, remote server lifecycle, and UI.
Native runtimes may maintain their own session files. Those files do not make Switchboard a durable workflow engine.

A local request ID does not establish exactly-once execution.
Future adapters must expose uncertainty after ambiguous native acceptance so the host can reconcile from supported native evidence.
The host must not blindly resubmit a message, approval, or continuation after losing its acknowledgement.
Cancellation does not imply rollback. Removing an observer does not imply cancellation.

Direct native authentication and proxy authentication are separate configuration paths.
LiteLLM owns upstream provider credentials. Switchboard authenticates to the proxy with host-resolved credentials.
Subscription credential passthrough through LiteLLM is outside v1.
A selected proxy route must not silently fall back to direct access.
Future adapters must scope credentials per adapter and session, preserve native approvals, and prevent secret disclosure in observable output.

## Source ownership and exports

`src/index.ts` is the only implemented entry point and contains `export {};`.
The root export maps to emitted JavaScript and declarations under `dist`.
Deep imports are private. The package verification command checks this restriction in an installed tarball.

The following directories describe future ownership. They do not imply implemented modules or exported entry points.

| Source area | Responsibility | Allowed direction |
| --- | --- | --- |
| `src/core/` | Public runtime contracts and native session references | No native SDK or AG-UI dependency |
| `src/adapters/claude/` | Claude native integration | May import core and Claude dependencies |
| `src/adapters/codex/` | Codex native integration | May import core and Codex dependencies |
| `src/adapters/pi/` | Pi native integration | May import core and Pi dependencies |
| `src/ag-ui/` | Canonical AG-UI mapping | May import core and canonical AG-UI types |

The root is intended to re-export core contracts once implemented.
Native adapters and AG-UI need explicit entry points when implemented so importing core does not load native integrations.
Third-party adapters must use public contracts without importing internal source files.
Native dependency and package-splitting decisions belong to the adapter tasks.

## Native prerequisites and checked evidence

Node 24.22.3 with npm 11.19.1 is the selected foundation toolchain.
TypeScript 7.0.2 compiles the package with strict NodeNext settings.
The supported Node range stays within this selected major until other versions receive validation.
[Node's release index](https://nodejs.org/dist/index.json) supplied the selected runtime and bundled npm evidence checked on 2026-11-13.

The registry metadata below was checked on 2026-11-13 during foundation design.
These versions are research evidence, not installed dependencies or live qualification results.

| Prospective dependency | Checked version | Declared Node prerequisite |
| --- | --- | --- |
| [Claude Agent SDK](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.323) | 0.3.323 | `>=18.14.0` |
| [Codex SDK](https://registry.npmjs.org/@openai/codex-sdk/0.169.0) | 0.169.0 | `>=18` |
| [Codex CLI](https://registry.npmjs.org/@openai/codex/0.169.0) | 0.169.0 | `>=16` |
| [Pi coding agent](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.2) | 1.5.2 | `>=22.19.0` |
| [Pi agent core](https://registry.npmjs.org/@earendil-works/pi-agent-core/1.5.2) | 1.5.2 | `>=22.19.0` |
| [Pi AI](https://registry.npmjs.org/@earendil-works/pi-ai/1.5.2) | 1.5.2 | `>=22.19.0` |

The [Codex SDK documentation](https://developers.openai.com/codex/sdk/) specifies server-side Node 18 or later.
[Codex app-server](https://developers.openai.com/codex/app-server/) uses a native Codex process.
The checked Codex launcher and Claude SDK manifests include platform-specific optional runtime packages.
The current [Pi source repository](https://github.com/earendil-works/pi) is authoritative for the checked `@earendil-works` packages.
Native integration qualification must establish executable availability, supported authentication, and authorized session access on the target host.
Dependency engine declarations alone do not establish those facts.
Switchboard's MIT license does not establish the license terms of prospective native dependencies.

All three native integrations require separate direct and LiteLLM qualification.
Record exact native, proxy, model, protocol, and source versions with configuration that excludes secrets.
Distinguish deterministic fixture checks from live evidence.
All GitHub Actions must use Linux runners. Record macOS native evidence separately.
The temporary consumer check proves packaging on the machine running it. It does not qualify a native integration on either platform.
