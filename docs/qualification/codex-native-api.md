# Native Codex app-server qualification

The pinned Codex 0.169.0 binary passes isolated Linux arm64 and Linux x64 qualification against a synthetic loopback Responses server. The x64 run uses Docker's QEMU emulation on the arm64 host; native x64 CI remains a separate execution environment. This evidence covers the native app-server protocol and its generated public bindings. Real provider access, LiteLLM compatibility, and production authorization remain unqualified.

The reproducible entry point is `spikes/codex-native/qualify.mjs`. It takes an official optional-platform npm archive and an architecture. `pins.json` records the exact arm64 and x64 artifact URLs and SHA512 digests from npm metadata. The Node image is pinned by its OCI index digest. Docker selects the corresponding platform with `--platform`. The runner verifies archive integrity before extracting or executing the binary and asserts its reported version.

The following commands describe the Linux x64 CI invocation with Node 24.22.3 and npm 11.19.1 already selected. The root lockfile provides TypeScript 7.0.2 and Node declarations 24.19.2. The runner verifies those installed versions.

```sh
npm ci --ignore-scripts
mkdir -p spikes/codex-native/.work
curl --fail --location --max-time 120 \
  --output spikes/codex-native/.work/codex-linux-x64.tgz \
  https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-linux-x64.tgz
docker pull --platform linux/amd64 node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
node spikes/codex-native/qualify.mjs spikes/codex-native/.work/codex-linux-x64.tgz x64
```

The arm64 invocation substitutes `linux-arm64.tgz`, `linux/arm64`, and `arm64`. The runner prints assertion results and observed HTTP calls as JSON. A failed assertion exits nonzero. Generated files and extracted executables live in a unique ignored directory. The runner removes it after confirmed container absence and retains it with its exact path when cleanup remains uncertain.

Each native execution uses `--rm --network none --read-only --pids-limit 128 --cpus 2 --memory 768m`. Fresh tmpfs mounts provide 128 MiB at `/tmp` and 64 MiB at `/root`. Only the verified executable, fixture code, and synthetic data are mounted read-only. There are no host credentials, history, home directories, or sockets in the container. There are no `HOME` or `CODEX_HOME` overrides. Synthetic credential commands and native thread state exist only inside the disposable container. Native commands have a 40-second container deadline and a 45-second host deadline. Individual protocol waits have six-second deadlines. HTTP bodies, HTTP request counts, native stdout, host stdout, and archive size have explicit limits.

| Assertion | Observed native behavior |
| --- | --- |
| Initialization | The public `initialize` request succeeds before `initialized` and thread operations. |
| Start-only thread | `thread/start` returns an ID, but another process cannot discover or resume it before its first turn. |
| External discovery | One app-server creates and persists a thread. Another app-server discovers its native ID with `thread/list`. |
| Resume | `thread/resume` returns the same ID and saved turns without an inference request. A subsequent native turn appends while preserving the saved file's byte prefix. |
| Command approval | An advertised `exec_command` call produces a native approval request. The client declines it, the native item becomes `declined`, and the command's marker file never exists. |
| Cancellation | `turn/interrupt` ends a held accepted response with native status `interrupted` after one inference request. |
| Accepted stream failure | A 200 SSE response sends a text delta and ends before `response.completed`. The turn fails after one inference request. |
| Accepted process loss | The app-server is killed after an accepted request. Another process resumes the thread without resubmitting inference or rewriting its saved prefix. |
| Credential cache | Two turns reuse one bearer without another helper invocation. |
| Rejected bearer | One 401 causes exactly one helper renewal and one successful authenticated retry, even when request and stream retry limits are zero. |
| Credential expiry | With a 50 ms refresh interval, a later turn receives a different bearer after the interval passes. |
| Failed proactive renewal | The helper exits nonzero, but Codex sends its cached bearer. The fixture accepts that still-valid token. |
| Failed renewal after 401 | The helper exits nonzero. The native turn fails after one rejected request and makes no accepted retry. |
| Initial credential failure | A new process with a failing helper sends a request without Authorization. The fixture rejects it with 401 and the turn fails. |

The retry assertions set both `request_max_retries` and `stream_max_retries` to zero. They do not establish default retry behavior. Metadata GET requests to `/v1/models` receive 404 and can repeat independently. The report counts those separately from inference POST requests. The extra request after an approval decision is the model continuation, whereas the request after 401 follows rejected authentication. Neither is evidence that accepted work was retried.

The native credential command is not a fail-closed authorization boundary in this configuration. Host invocation denial must prevent invocation. A host requiring zero dispatch after any later native helper failure has a conditional policy conflict unless an additional enforcement path is separately qualified. Preflight alone does not control a later internal refresh. The fixture proves neither token revocation nor upstream OAuth refresh. `refresh_interval_ms` measures cache age; it does not parse token expiry claims. Synthetic tokens contain no account data.

The generated binding check invokes the exact binary's public `app-server generate-ts` command without experimental bindings. The resulting 784 TypeScript files use extensionless relative module specifiers. `qualify.mjs` adds `.js` for existing sibling modules and `/index.js` for existing directory modules. It asserts that every converted target exists. This private generation transform changes module specifiers only. It does not copy private source or alter protocol types.

All generated files and `consumer.ts` pass TypeScript 7.0.2 with `strict`, NodeNext modules and resolution, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `lib: ["ES2022"]`, Node declarations, and `skipLibCheck: false`. No DOM library, ambient shim, SDK dependency, or global compiler-policy change is needed. This proves the generated-binding approach after the explicit import transform. It does not claim the raw generator output is directly NodeNext-compatible.

Broader adapter qualification still requires live direct and both LiteLLM journeys, approval acceptance and file-change approval journeys, permission and user-question round trips, and explicit outcome-unknown handling after ambiguous process loss. Strict fail-closed behavior after native helper failure is required only when the host selects that stronger policy. Tool execution acceptance remains untested because this fixture only declines the native command request. The host still owns durable admission, writer exclusivity, and the decision to reconcile an uncertain accepted effect instead of retrying it.

Official documentation corroborates the public generator, request lifecycle, and command approval protocol in [Codex app-server](https://learn.chatgpt.com/docs/app-server). The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents command credentials, the refresh interval, and its zero-value semantics. The executable assertions establish the exact pinned behavior described above. Documentation was read on 2026-11-13; current documentation is not an immutable substitute for the pinned run.
