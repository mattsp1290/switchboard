const outcomes = new Set(['success', 'error', 'cancelled', 'outcome-unknown']);

function safeIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function copyAttributes(attributes) {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
}

export function datadogSpanView(span) {
  const metadata = {};
  if (outcomes.has(span.attributes['switchboard.outcome'])) metadata.outcome = span.attributes['switchboard.outcome'];
  for (const [source, target] of [['switchboard.run_id', 'run_id'], ['switchboard.request_id', 'request_id']]) {
    const value = span.attributes[source];
    if (safeIdentifier(value)) metadata[target] = value;
  }
  const identity = { ...span.spanContext() };
  return {
    name: span.name, kind: span.kind, spanContext: () => ({ ...identity }),
    ...(span.parentSpanContext ? { parentSpanContext: { ...span.parentSpanContext } } : {}),
    startTime: [...span.startTime], endTime: [...span.endTime], duration: [...span.duration],
    status: { ...span.status }, attributes: { ...copyAttributes(span.attributes),
      ...(Object.keys(metadata).length ? { '_dd.ml_obs.metadata': JSON.stringify({ switchboard: metadata }) } : {}) },
    links: span.links.map((link) => ({ ...link, context: { ...link.context }, attributes: copyAttributes(link.attributes ?? {}) })),
    events: span.events.map((event) => ({ ...event, time: [...event.time], attributes: copyAttributes(event.attributes ?? {}) })),
    resource: span.resource, instrumentationScope: { ...span.instrumentationScope }, ended: span.ended,
    droppedAttributesCount: span.droppedAttributesCount, droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function createDatadogExporter(exporter) {
  return {
    export(spans, callback) {
      let called = false;
      const complete = (result) => { if (!called) { called = true; callback(result); } };
      try { exporter.export(spans.map(datadogSpanView), complete); }
      catch { complete({ code: 1, error: new Error('Datadog exporter failed') }); }
    },
    forceFlush() {
      return Promise.resolve().then(() => exporter.forceFlush?.());
    },
    shutdown() {
      return Promise.resolve().then(() => exporter.shutdown());
    },
  };
}
