# Validate telemetry destinations

Use Node 24.22.3 and npm 11.19.1. Run the commands from the repository root. These checks install a packed consumer and send only deterministic synthetic observations.

## Verify the installed API

```sh
npm ci
npm run lint
npm run check
npm test
npm run verify:compiler
npm run verify:agui
```

The package gate executes real SDK export tests, strict consumer types, privacy and lifecycle checks, and a real loopback HTTP fixture. It requires no Datadog credentials, Docker, native SDK, or live model call.

## Validate lotel collection and queries

Install Docker, a C compiler, and Go 1.24.4 or newer. The CI lane uses Go 1.26.0. Supply `LOTEL_BIN` or `LOTEL_SOURCE` to reuse the exact pinned tool. Otherwise the runner fetches and builds lotel at the commit in [qualification-pin.json](qualification-pin.json).

```sh
npm run verify:observability:lotel
```

Keep ports 4317, 4318, and 13133 free when starting a collector. Lotel uses the fixed Docker name `lotel-collector`. Changing HOME isolates files but cannot isolate that name or those ports. The runner must establish ownership before starting, and must never restart or reconfigure a pre-existing collector.

The runner exports spans, runs ingest, and queries GenAI calls, usage, raw traces, and content. It checks exact fixture IDs and parentage. The successful pair must contain two model calls with seven input and four output tokens. Agent and tool spans do not enter model totals. Missing usage stays absent. A successful HTTP export does not satisfy this check.

Inspect the bounded result in `.audit/llm-observability/lotel.json`. A failure exits nonzero. The runner removes only resources it created and records cleanup status.

## Check the local Datadog receiver

Use the existing authenticated Pup CLI. Keep credentials outside the library and fixture. Confirm both agent services and the loopback HTTP receiver before running qualification.

```sh
systemctl is-active datadog-agent.service datadog-agent-trace.service
ss -ltn '( sport = :14318 )'
curl --fail --silent --show-error --max-time 5 \
  -H 'Content-Type: application/x-protobuf' \
  --data-binary '' http://127.0.0.1:14318/v1/traces
```

An empty OTLP response tests the receiver only. It does not prove LLM conversion or cloud indexing.

The planning environment uses Agent 7.76.3 and Pup 2.0.1 on `us3.datadoghq.com`. Its receiver was enabled by the host operator with two temporary drop-ins. Reboot removes those settings. If the listener is absent, the host operator must restore it before the required Datadog lane can pass.

## Validate Datadog LLM conversion

Set `PUP_BIN` if Pup is absent from PATH. Use the already authenticated host environment.

```sh
PUP_BIN="$HOME/git/pup/target/release/pup" \
DD_SITE=us3.datadoghq.com npm run verify:observability:datadog
```

The runner exports to `http://127.0.0.1:14318/v1/traces` through the local agent. It queries Pup's LLM Observability commands and follows backend-returned IDs. It allows bounded indexing delay without repeating model requests.

Require converted `agent`, `llm`, and `tool` kinds, correct parents, models, observed usage, and terminal outcomes. Confirm default content absence and approved sanitized text in detailed stored fields. APM results, unrelated existing traces, and accepted OTLP requests do not satisfy this check.

Inspect `.audit/llm-observability/datadog.json`. Reports contain synthetic IDs, counts, versions, and pass predicates. They omit authentication and raw content.

## Validate both destinations from the same observations

To compare original span identities across backends, enable Datadog fan-out during the lotel run. Then reuse its bounded fixture evidence for Datadog queries.

```sh
DATADOG_ENDPOINT=http://127.0.0.1:14318/v1/traces \
  npm run verify:observability:lotel
PUP_BIN="$HOME/git/pup/target/release/pup" \
OBSERVABILITY_FIXTURE_REPORT=.audit/llm-observability/fixture.json \
  npm run verify:observability:datadog
```

The second command queries existing observations and makes no model requests. It requires all seven scenarios, a passed originating lotel report, the same artifact hash, and unchanged implementation sources. Export a new fixture after changing those sources.

The runner refuses an existing collector even when healthy. This conservative ownership policy requires a free Docker daemon for the lotel lane.

## Retain or roll back the temporary receiver

Qualification preserves the shared agent and its existing configuration. Keep the temporary loopback receiver for further development if needed. To remove the exact planning drop-ins, have the host operator run these commands after confirming both files belong to this setup.

```sh
sudo rm /run/systemd/system/datadog-agent.service.d/switchboard-otlp.conf \
  /run/systemd/system/datadog-agent-trace.service.d/switchboard-otlp.conf
sudo systemctl daemon-reload
sudo systemctl restart datadog-agent.service datadog-agent-trace.service
systemctl is-active datadog-agent.service datadog-agent-trace.service
ss -ltn '( sport = :14318 )'
```

Removing these files does not remove permanent or unrelated OTLP configuration. Do not use `systemctl revert` because it can remove other overrides.
