import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSessionReference, serializeDiagnostic } from '@mattsp1290/switchboard';

/** @typedef {import('@mattsp1290/switchboard').SessionDiscoveryPage} SessionDiscoveryPage */
/** @typedef {import('@mattsp1290/switchboard').SessionDiscoveryDiagnostic} SessionDiscoveryDiagnostic */
/** @typedef {{ readonly root: string }} Scope */
/** @typedef {{ readonly kind: 'complete' } | { readonly kind: 'cancelled' } |
 * { readonly kind: 'truncated', readonly reason: 'results' | 'examined' | 'duration' }} End */

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
 * @param {End} end
 * @param {() => void} afterObservations
 * @returns {import('@mattsp1290/switchboard').SessionDiscovery<Scope>}
 */
function controlledDiscovery(end, afterObservations = () => {}) {
  return {
    async discover({ signal }) {
      if (signal.aborted) {
        return { kind: 'ok', value: {
          kind: 'cancelled', sessions: [], examined: 0,
          skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: [],
        } };
      }
      const observations = {
        sessions: [session], examined: 3, skipped: { corrupt: 0, inaccessible: 0 }, diagnostics: failures,
      };
      afterObservations();
      return { kind: 'ok', value: {
        ...observations, ...(signal.aborted ? { kind: 'cancelled' } : end),
      } };
    },
  };
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
  ];
  for (const end of endings) {
    const result = await controlledDiscovery(end).discover(access(new AbortController().signal));
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') throw new Error('Expected retained discovery page.');
    retainedObservations(result.value);
    assert.equal(termination(result.value), end.kind === 'truncated' ? end.reason : end.kind);
  }
});

test('installed discovery preserves settled failures on abort and returns an empty pre-aborted page', async () => {
  const controller = new AbortController();
  const discovery = controlledDiscovery({ kind: 'complete' }, () => controller.abort());
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
