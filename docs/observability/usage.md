# Record observed agent work

Install the optional API peer in your host application.

```sh
npm install --save-exact @opentelemetry/api@1.9.0
```

Add your host's OpenTelemetry SDK and exporters separately. The qualification fixture pins SDK 2.12.0 and OTLP exporter 0.223.0 in [qualification-pin.json](qualification-pin.json).

## Create a host-owned provider

Create the provider in the host. Borrow its tracer when constructing an observer. Use the versioned Switchboard instrumentation scope.

```js
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
	createGenAiObserver,
	instrumentationScope,
} from '@mattsp1290/switchboard/observability';

const exporter = new OTLPTraceExporter({
	url: 'http://127.0.0.1:4318/v1/traces',
	timeoutMillis: 5_000,
});
const provider = new NodeTracerProvider({
	resource: resourceFromAttributes({ 'service.name': 'my-agent-host' }),
	spanProcessors: [new BatchSpanProcessor(exporter, {
		maxQueueSize: 256,
		maxExportBatchSize: 32,
		scheduledDelayMillis: 200,
		exportTimeoutMillis: 5_000,
	})],
});
const observer = createGenAiObserver({
	tracer: provider.getTracer(instrumentationScope.name, instrumentationScope.version),
	contentPolicy: { kind: 'none' },
	allowedToolNames: ['lookup'],
});
```

Provider registration is unnecessary for explicit parent contexts. If your host registers a global provider or context manager, keep that registration and its cleanup in the host.

## Record an agent invocation

Start the observation at the actual agent invocation boundary. Pass a safe host-generated correlation ID. Check the recording result independently of the native result.

```js
const recording = observer.start(
	{ kind: 'agent', provider: 'openai', name: 'assistant' },
	ROOT_CONTEXT,
	{ runId: 'host-generated-public-run-id' },
);

try {
	await invokeAgent();
	if (recording.kind === 'ok') recording.value.finish({ kind: 'success' });
} catch (error) {
	if (recording.kind === 'ok') {
		recording.value.finish({ kind: 'error', category: 'provider-error' });
	}
	throw error;
}
```

Replace `invokeAgent` with the host's actual invocation. Keep native execution outside the recording API. A failed recording must not cause a retry or prevent native entry.

For a dispatch operation, record only the observed agent invocation around the host's existing single-attempt dispatch. Preserve the dispatch result separately. Finish an ambiguous native acceptance as `outcome-unknown`. Do not translate an abort signal into confirmed native cancellation without evidence.

## Record a model request you control

Start one model handle per actual provider request. Use the agent handle's context as the explicit parent. Supply correlations again on each child.

```js
const modelRecording = observer.start({
	kind: 'model',
	provider: 'openai',
	operation: 'chat',
	requestModel: 'requested-model',
}, recording.kind === 'ok' ? recording.value.context : ROOT_CONTEXT, {
	runId: 'host-generated-public-run-id',
	requestId: 'host-generated-public-request-id',
});

try {
	const response = await requestProvider();
	if (modelRecording.kind === 'ok') {
		modelRecording.value.update({
			responseModel: response.model,
			usage: response.usage,
		});
		modelRecording.value.finish({ kind: 'success' });
	}
} catch (error) {
	if (modelRecording.kind === 'ok') {
		modelRecording.value.finish({ kind: 'error', category: 'provider-error' });
	}
	throw error;
}
```

Replace `requestProvider` with your provider integration and adapt its observed usage to `{ inputTokens?, outputTokens? }`. Omit unobserved counts. Send observed totals once, or replace them with a later observed total. Do not add token counts from stream chunks or copy aggregate agent usage into individual requests.

Start a tool observation only when an allowlisted tool actually executes. A proposed tool call or approval request is insufficient.

Native adapters remain unqualified. If a native API does not expose individual model request boundaries, record the agent invocation alone. See [ownership and visibility](../architecture/boundaries.md#genai-observations).

## Enable sanitized text deliberately

Keep `contentPolicy: { kind: 'none' }` for metadata-only spans. To export selected text, supply a sanitizer that returns approved text in the same direction and schema.

```js
const contentPolicy = {
	kind: 'sanitized',
	sanitize(observation) {
		return {
			kind: observation.kind,
			messages: observation.messages.map(message => ({
				...message,
				parts: message.parts.map(() => ({
					type: 'text',
					content: '[approved replacement]',
				})),
			})),
		};
	},
};
```

Pass input messages through a model descriptor's `inputMessages`. Pass output messages through `update({ outputMessages })`. Use text parts of `{ type: 'text', content: string }`. Output messages require the observed `finish_reason`; omit output messages if it is unavailable. The parser implements the text-only subset of GenAI v1.37.0.

Choose non-secret provider, model, agent, tool, and correlation identifiers. Enable `includeConversationId: true` only for a safe host-supplied conversation ID. Never derive these identifiers from native handles, paths, credentials, or account IDs.

## Send to Datadog through your agent

Create a separate OTLP exporter for the agent's HTTP receiver. In the qualification environment its URL is `http://127.0.0.1:14318/v1/traces`. Add `dd_llmobs_enabled: true` to the provider's resource attributes. Keep forwarding credentials in the agent.

Wrap only the Datadog exporter with the host recipe in `scripts/support/datadog-exporter.mjs`. It adds a bounded `_dd.ml_obs.metadata` JSON object for outcome, run ID, and request ID. Keep a separate processor for lotel so a destination failure cannot suppress the other export attempt. The recipe adapts export metadata and creates no extra spans.

Datadog's [OpenTelemetry mapping](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/) documents conversion and custom metadata. Follow [backend validation](validation.md) to check converted LLM spans, rather than accepting a transport response as proof.

## Close observations and flush the host provider

Stop producing observations before cleanup. Close the observer, then flush and shut down the provider under the host's deadlines.

```js
observer.close();
await provider.forceFlush();
await provider.shutdown();
```

Use a finite deadline for each host SDK wait. The qualification runners allow ten seconds. `close()` ends open observations as `outcome-unknown`; it never cancels native work, shuts down a borrowed provider, or waits for network export.
