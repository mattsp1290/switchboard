import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionReference, serializeDiagnostic } from '@mattsp1290/switchboard';

/** @typedef {import('@mattsp1290/switchboard').SessionDiscoveryPage} SessionDiscoveryPage */
/** @typedef {import('@mattsp1290/switchboard').SessionDiscoveryDiagnostic} SessionDiscoveryDiagnostic */
/** @typedef {{ readonly root: string }} Scope */
/** @typedef {{ readonly kind: 'complete' } | { readonly kind: 'cancelled' } |
 * { readonly kind: 'truncated', readonly reason: 'results' | 'examined' | 'duration' } |
 * { readonly kind: 'failed', readonly code: 'inaccessible' | 'native-failure' }} End */

const binding = {
  engine: 'acme/native', nativeVersion: '1.2', account: 'account-a',
  authorizedScope: 'workspace-a', nativeFormat: 'acme/session-v3',
};
/** @type {import('@mattsp1290/switchboard').SessionReference} */
const session = { kind: 'session', formatVersion: 1, binding, opaque: 'native-session-a' };
/** @type {readonly SessionDiscoveryDiagnostic[]} */
const failures = [
  { kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '1' } },
  { kind: 'file-inspection-failed', subject: { kind: 'discovery-file', token: '2' } },
];

/**
 * @param {End | (() => Promise<End>)} end
 * @param {{ afterObservations?: () => void, afterSettlement?: () => Promise<void>,
 * candidates?: readonly (import('@mattsp1290/switchboard').SessionReference | SessionDiscoveryDiagnostic)[] }} options
 * @returns {import('@mattsp1290/switchboard').SessionDiscovery<Scope>}
 */
function controlledDiscovery(end, {
  afterObservations = () => {}, afterSettlement = async () => {}, candidates = [session, ...failures],
} = {}) {
  return {
    async discover({ signal }) {
      const observations = {
        /** @type {import('@mattsp1290/switchboard').SessionReference[]} */
        sessions: [], examined: 0, skipped: { corrupt: 0, inaccessible: 0 },
        /** @type {SessionDiscoveryDiagnostic[]} */
        diagnostics: [],
      };
      if (signal.aborted) return { kind: 'ok', value: { ...observations, kind: 'cancelled' } };
      /** @type {End | undefined} */
      let settled;
      const abort = () => { settled ??= { kind: 'cancelled' }; };
      signal.addEventListener('abort', abort, { once: true });
      try {
        for (const candidate of candidates) {
          observations.examined += 1;
          if (candidate.kind === 'session') observations.sessions.push(candidate);
          else observations.diagnostics.push(candidate);
        }
        afterObservations();
        try {
          const requested = typeof end === 'function' ? await end() : end;
          settled ??= requested;
        } catch {
          settled ??= { kind: 'failed', code: 'native-failure' };
        }
        await afterSettlement();
        return { kind: 'ok', value: { ...observations, ...settled } };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

function deferred() {
  let resolve = () => {};
  /** @type {(reason: unknown) => void} */
  let reject = () => {};
  /** @type {Promise<void>} */
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** @param {AbortSignal} signal @returns {import('@mattsp1290/switchboard').SessionAccess<Scope>} */
function access(signal) {
  return {
    binding, scope: { root: '/controlled-fixture' },
    bounds: { maxResults: 1, maxExamined: 3, maxDurationMs: 100 }, signal,
  };
}

/** @param {SessionDiscoveryPage} page */
function retainedObservations(page) {
  assert.deepEqual(page.sessions, [session]);
  assert.equal(page.examined, 3);
  assert.deepEqual(page.diagnostics, failures);
  assert.equal(new Set(page.diagnostics.map(diagnostic => diagnostic.subject.token)).size, 2);
  assert.deepEqual(page.skipped, { corrupt: 0, inaccessible: 0 });
}

/** @param {SessionDiscoveryPage} page */
function termination(page) {
  switch (page.kind) {
    case 'complete': return 'complete';
    case 'cancelled': return 'cancelled';
    case 'truncated': return page.reason;
    case 'failed': return page.code;
    default: {
      /** @type {never} */
      const exhaustive = page;
      return exhaustive;
    }
  }
}

test('installed discovery retains sessions and unidentified file failures for every termination', async () => {
  /** @type {readonly End[]} */
  const endings = [
    { kind: 'complete' }, { kind: 'truncated', reason: 'results' },
    { kind: 'truncated', reason: 'examined' }, { kind: 'truncated', reason: 'duration' },
    { kind: 'cancelled' },
    { kind: 'failed', code: 'inaccessible' }, { kind: 'failed', code: 'native-failure' },
  ];
  for (const end of endings) {
    const result = await controlledDiscovery(end).discover(access(new AbortController().signal));
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') throw new Error('Expected retained discovery page.');
    retainedObservations(result.value);
    assert.equal(termination(result.value), end.kind === 'truncated' ? end.reason
      : end.kind === 'failed' ? end.code : end.kind);
  }
});

test('installed discovery preserves settled failures on abort and returns an empty pre-aborted page', async () => {
  const controller = new AbortController();
  const discovery = controlledDiscovery({ kind: 'complete' }, { afterObservations: () => controller.abort() });
  const result = await discovery.discover(access(controller.signal));
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Expected retained cancelled page.');
  assert.equal(termination(result.value), 'cancelled');
  retainedObservations(result.value);
  assert.deepEqual(await discovery.discover(access(controller.signal)), {
    kind: 'ok', value: {
      kind: 'cancelled', sessions: [], examined: 0,
      skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [],
    },
  });
});

test('installed controlled discovery retains a settled fatal page through later abort and cleanup', async () => {
  const controller = new AbortController();
  const failure = deferred();
  const observed = deferred();
  const settled = deferred();
  const cleanup = deferred();
  const resultPromise = controlledDiscovery(async () => {
    await failure.promise;
    return { kind: 'complete' };
  }, {
    afterObservations: observed.resolve,
    afterSettlement: async () => { settled.resolve(); await cleanup.promise; },
  }).discover(access(controller.signal));
  await observed.promise;
  failure.reject(new Error('/private/native-file account-secret native-id'));
  await settled.promise;
  controller.abort();
  cleanup.resolve();
  const result = await resultPromise;
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Expected retained fatal page.');
  assert.equal(result.value.kind, 'failed');
  assert.equal(termination(result.value), 'native-failure');
  retainedObservations(result.value);
  assert.doesNotMatch(JSON.stringify(result), /private|account-secret|native-id/);
  assert.equal(serializeDiagnostic(result.value), '{"kind":"redacted","category":"native-data"}');
});

test('installed controlled discovery settles abort before an outstanding failure without inventing a diagnostic', async () => {
  const controller = new AbortController();
  const failure = deferred();
  const observed = deferred();
  const settled = deferred();
  const resultPromise = controlledDiscovery(async () => {
    await failure.promise;
    return { kind: 'complete' };
  }, { afterObservations: observed.resolve, afterSettlement: async () => { settled.resolve(); } })
    .discover(access(controller.signal));
  await observed.promise;
  controller.abort();
  failure.reject(new Error('Unsettled native operation failed.'));
  await settled.promise;
  const result = await resultPromise;
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('Expected retained cancelled page.');
  assert.equal(termination(result.value), 'cancelled');
  retainedObservations(result.value);
});

test('installed controlled discovery can return a failed page before any observation settles', async () => {
  const result = await controlledDiscovery(async () => {
    throw new Error('Failure before the first candidate.');
  }, { candidates: [] }).discover(access(new AbortController().signal));
  assert.deepEqual(result, {
    kind: 'ok', value: {
      kind: 'failed', code: 'native-failure', sessions: [], examined: 0,
      skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [],
    },
  });
});

test('installed discovery file diagnostics grant no session reference or safe serialization provenance', () => {
  assert.deepEqual(parseSessionReference({ value: session, expected: binding }), { kind: 'ok', value: session });
  for (const diagnostic of failures) {
    for (const value of [diagnostic, diagnostic.subject]) {
      assert.deepEqual(parseSessionReference({ value, expected: binding }), {
        kind: 'error', error: { code: 'invalid-reference' },
      });
      assert.equal(serializeDiagnostic(value), '{"kind":"redacted","category":"native-data"}');
    }
  }
});
