import {
  createDispatchOperation, createEventStream, parseInteractionContinuation, parseSessionReference,
} from '@mattsp1290/switchboard';

const namespace = 'switchboard-qualification';
const fail = (code) => ({ kind: 'error', error: { code } });

function freezeTree(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') freezeTree(child);
  }
  return Object.freeze(value);
}

function track(tasks, promise) {
  tasks.add(promise);
  promise.then(() => tasks.delete(promise), () => tasks.delete(promise));
  return promise;
}

export function createFakeFixture() {
  const binding = {
    engine: 'fixture', nativeVersion: '1', account: 'test-account',
    authorizedScope: 'test-scope', nativeFormat: 'fixture-session-v1',
  };
  const a = { kind: 'session', formatVersion: 1, binding, opaque: 'session-a' };
  const b = { ...a, opaque: 'session-b' };
  const extension = { namespace, schemaVersion: 1, data: {} };
  const samples = freezeTree({
    a, b,
    approval: {
      kind: 'approval',
      target: { kind: 'approval', session: a, nativeApprovalId: 'approval-1', tool: null },
      nativePolicy: extension, request: extension,
      choices: [{ nativeChoiceId: 'allow-once', label: 'Allow once' }],
    },
    tool: { kind: 'tool', target: { kind: 'tool', session: a, nativeToolCallId: 'tool-1' } },
  });
  const identity = Object.freeze({ engine: 'fixture', adapter: namespace, version: '1', contractVersion: 1 });
  const sessions = new Map([a, b].map((reference) => [reference.opaque,
    { reference, reservation: null, pending: null }]));
  const records = [];
  const counts = { dispatchAttempts: 0, acceptedEffects: 0, lookupCalls: 0, transportCloses: 0 };
  const gates = new Set();
  const connections = new Set();
  const bridges = new Set();
  const submits = new Set();
  const completions = new Set();
  let nextLoss = false;
  let nextCompletion = null;
  let visibility = 'authoritative';
  let disposing = false;
  let disposePromise;

  function holdNextCompletion() {
    if (nextCompletion !== null) throw new Error('A completion gate is already armed.');
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const completed = Promise.withResolvers();
    const gate = { entered, released, completed, release: () => released.resolve() };
    gates.add(gate);
    nextCompletion = gate;
    return { entered: entered.promise, release: gate.release, completed: completed.promise };
  }

  function observe(record, source) {
    const evidence = {
      identity: record.identity, source,
      nativeOperation: { namespace, id: record.receipt },
      observation: { namespace, schemaVersion: 1, data: { state: record.state } },
    };
    return record.state === 'accepted' ? { kind: 'accepted', evidence }
      : { kind: 'conclusive', evidence, result: { continuation: record.continuation } };
  }

  function finish(record) {
    record.state = 'conclusive';
    if (record.session.reservation === record.reservation) record.session.reservation = null;
    if (record.gate) {
      record.gate.completed.resolve();
      gates.delete(record.gate);
    }
  }

  function connect(recordIntent) {
    if (disposing) throw new Error('Fixture is disposed.');
    const stream = createEventStream({ maxObservers: 2, capacity: 2 });
    bridges.add(stream);
    let closed = false;
    let closePromise;

    function accept(canonicalIdentity, session, continuation, reservation) {
      if (closed) throw new Error('Transport is closed.');
      const loss = nextLoss;
      const gate = nextCompletion;
      nextLoss = false;
      nextCompletion = null;
      counts.dispatchAttempts++;
      const record = {
        identity: canonicalIdentity, receipt: `receipt-${records.length + 1}`,
        continuation, session, reservation, gate, state: 'accepted',
      };
      records.push(record);
      counts.acceptedEffects++;
      reservation.accepted = true;
      if (continuation !== undefined) session.pending = null;
      if (gate) {
        track(completions, gate.released.promise.then(() => finish(record)));
        gate.entered.resolve();
      } else {
        finish(record);
      }
      if (loss) throw new Error('Acknowledgement was lost after acceptance.');
      return observe(record, 'native-acknowledgement');
    }

    function lookup(previous) {
      if (closed) throw new Error('Transport is closed.');
      counts.lookupCalls++;
      const matches = records.filter((record) =>
        JSON.stringify(record.identity) === JSON.stringify(previous.identity));
      if (visibility === 'unknown' || matches.length !== 1) return { kind: 'outcome-unknown' };
      return observe(matches[0], 'authoritative-native-lookup');
    }

    function submit(request, signal) {
      if (closed) return Promise.resolve(fail('closed'));
      const parsed = parseSessionReference({ value: request.session, expected: binding });
      if (parsed.kind === 'error') return Promise.resolve(parsed);
      const session = sessions.get(parsed.value.opaque);
      if (!session) return Promise.resolve(fail('missing-session'));
      let continuation;
      if (request.continuation !== undefined) {
        if (!session.pending) return Promise.resolve(fail('stale-interaction'));
        const checked = parseInteractionContinuation({ value: request.continuation, expected: session.pending });
        if (checked.kind === 'error') return Promise.resolve(checked);
        continuation = checked.value;
      }
      if (session.reservation) return Promise.resolve(fail('busy'));
      const reservation = { accepted: false };
      session.reservation = reservation;
      return track(submits, execute());

      async function execute() {
        try {
          const operation = createDispatchOperation({
            mode: 'fresh', signal,
            identity: { hostOperationId: request.hostOperationId,
              target: { kind: 'session', reference: session.reference } },
            recordIntent: async (canonicalIdentity, intentSignal) => {
              if (closed) throw new Error('Transport is closed.');
              await recordIntent(canonicalIdentity, intentSignal);
              if (closed) throw new Error('Transport closed during intent.');
            },
            dispatchNative: (canonicalIdentity) => accept(canonicalIdentity, session, continuation, reservation),
          });
          return { kind: 'ok', value: await operation.run() };
        } finally {
          if (!reservation.accepted && session.reservation === reservation) session.reservation = null;
        }
      }
    }

    function recover(saved) {
      if (saved.observation.kind === 'not-dispatched') throw new TypeError('Cannot recover undispatched work.');
      return createDispatchOperation({
        mode: 'recovery', identity: saved.identity, previous: saved.observation, reconcileNative: lookup,
      });
    }

    function close() {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve({ kind: 'ok', value: undefined });
      closed = true;
      bridges.delete(stream);
      stream.close();
      counts.transportCloses++;
      return closePromise;
    }

    const connection = { identity, events: { subscribe: stream.subscribe }, submit, recover, close };
    connections.add(connection);
    return connection;
  }

  const controls = {
    loseNextAcknowledgement() { nextLoss = true; },
    holdNextCompletion,
    lookupVisibility(mode) {
      if (mode !== 'unknown' && mode !== 'authoritative') throw new TypeError('Invalid lookup visibility.');
      visibility = mode;
    },
    pending(value) {
      const checked = parseSessionReference({ value: value.target.session, expected: binding });
      if (checked.kind === 'error' || !sessions.has(checked.value.opaque)) throw new TypeError('Invalid pending session.');
      sessions.get(checked.value.opaque).pending = freezeTree(structuredClone(value));
    },
    emit(sequence) {
      for (const bridge of bridges) bridge.publish({ kind: 'progress', sequence });
    },
    counts: () => ({ ...counts }),
  };

  function dispose() {
    if (disposePromise) return disposePromise;
    disposing = true;
    for (const gate of gates) gate.release();
    const closes = [...connections].map((connection) => Promise.resolve().then(connection.close));
    disposePromise = Promise.allSettled([...closes, ...submits, ...completions]).then((results) => {
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed.');
    });
    return disposePromise;
  }

  return { samples, connect, controls, dispose };
}
