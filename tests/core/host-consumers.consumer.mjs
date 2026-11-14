import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFakeFixture } from './qualification/harness/fake.mjs';
import { createCrewActivity, openAgentView } from './qualification/host-consumers.mjs';

function ok(outcome) {
  assert.equal(outcome.kind, 'ok');
  return outcome.value;
}

function wait(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

const correlation = { threadId: 'host-thread', runId: 'host-run', requestId: 'host-request' };
const hostOperationId = 'host-command';
const journal = (file) => JSON.parse(readFileSync(file, 'utf8'));

function crewOptions(fixture, journalFile) {
  return { connect: fixture.connect, journalFile, expectedBinding: fixture.samples.a.binding,
    grant: fixture.samples.a, correlation, hostOperationId };
}

function viewOptions(fixture, onProgress = () => {}) {
  return { connection: fixture.connect(() => {}), correlation, pending: fixture.samples.approval,
    hostOperationId: 'host-approval-command', onProgress,
    capabilities: [{ kind: 'supported', api: () => {} },
      { kind: 'unsupported', reason: 'Native checkpoint is absent.' },
      { kind: 'unavailable', reason: 'Host account is disconnected.' }] };
}

function replyFor(pending) {
  return { formatVersion: 1, kind: 'approval', target: structuredClone(pending.target),
    nativeChoiceId: pending.choices[0].nativeChoiceId };
}

async function crewScenario(signal, wrapOwner = (owner) => owner) {
  const directory = mkdtempSync(join(tmpdir(), 'switchboard-crew-'));
  const journalFile = join(directory, 'command.json');
  const fixture = createFakeFixture();
  try {
    const configured = structuredClone(crewOptions(fixture, journalFile).grant);
    const callerCorrelation = structuredClone(correlation);
    const request = { session: structuredClone(configured), hostOperationId };
    let persisted = false;
    let first = createCrewActivity({ ...crewOptions(fixture, journalFile), grant: configured,
      correlation: callerCorrelation, onIntentPersisted() {
        assert.deepEqual(fixture.controls.counts(),
          { dispatchAttempts: 0, acceptedEffects: 0, lookupCalls: 0, transportCloses: 0 });
        assert.deepEqual(journal(journalFile), { kind: 'intent', correlation,
          identity: { hostOperationId, target: { kind: 'session', reference: fixture.samples.a } } });
        persisted = true;
        configured.binding.account = 'mutated-account';
        configured.opaque = 'mutated-grant';
        request.session.opaque = 'mutated-request';
        callerCorrelation.requestId = 'mutated-host-id';
      } });
    const held = fixture.controls.holdNextCompletion();
    fixture.controls.loseNextAcknowledgement();
    const original = await first.execute(request, signal);
    await wait(held.entered, signal);
    held.release();
    await wait(held.completed, signal);
    assert.equal(persisted, true, 'intent bytes exist before native entry');
    assert.equal(original.observation.kind, 'outcome-unknown');
    const saved = journal(journalFile);
    const changed = structuredClone(original);
    changed.identity.target.reference.binding.authorizedScope = 'mutated-scope';
    changed.identity.target.reference.opaque = 'mutated-snapshot';
    assert.deepEqual(journal(journalFile), saved, 'saved bytes survive caller mutations');
    ok(await first.close());
    first = undefined;

    const reconstructed = wrapOwner(createCrewActivity(crewOptions(fixture, journalFile)), fixture);
    const retry = { session: fixture.samples.a, hostOperationId };
    fixture.controls.lookupVisibility('unknown');
    const hidden = await reconstructed.execute(retry, signal);
    assert.equal(fixture.controls.counts().acceptedEffects, 1, 'host must not resubmit saved unknown work');
    assert.deepEqual(hidden, saved.snapshot, 'reconstructed owner reads the saved unknown snapshot');
    fixture.controls.lookupVisibility('authoritative');
    const found = await reconstructed.execute(retry, signal);
    assert.equal(found.observation.kind, 'conclusive');
    assert.equal(found.observation.evidence.source, 'authoritative-native-lookup');
    assert.deepEqual(found.identity, saved.snapshot.identity);
    assert.deepEqual(fixture.controls.counts(),
      { dispatchAttempts: 1, acceptedEffects: 1, lookupCalls: 2, transportCloses: 1 },
      'saved unknown selects lookup without recording intent or sending again');

    const intentOnly = { kind: 'intent', identity: saved.snapshot.identity, correlation };
    const wrongBinding = structuredClone(saved);
    wrongBinding.snapshot.identity.target.reference.binding.account = 'other-account';
    const wrongCommand = structuredClone(saved);
    wrongCommand.snapshot.identity.hostOperationId = 'other-command';
    const wrongCorrelation = structuredClone(saved);
    wrongCorrelation.correlation.requestId = 'other-request';
    const malformed = { ...saved, snapshot: { ...saved.snapshot, observation: { kind: 'accepted' } } };
    for (const [record, expected] of [[intentOnly, /Intent requires investigation/],
      [wrongBinding, /binding-mismatch/], [wrongCommand, /Wrong command identity/],
      [wrongCorrelation, /Invalid host journal/], [malformed, /Invalid host journal/],
      [null, /Invalid host journal/]]) {
      writeFileSync(journalFile, JSON.stringify(record));
      const before = fixture.controls.counts();
      await assert.rejects(reconstructed.execute(retry, signal), expected);
      assert.deepEqual(fixture.controls.counts(), before, 'invalid saved records cannot reach the backend');
    }
    writeFileSync(journalFile, '{');
    const before = fixture.controls.counts();
    await assert.rejects(reconstructed.execute(retry, signal), SyntaxError);
    assert.deepEqual(fixture.controls.counts(), before);
    writeFileSync(journalFile, JSON.stringify(saved));
    await assert.rejects(reconstructed.execute({ ...retry, hostOperationId: 'other-command' }, signal), /Wrong command identity/);
    assert.deepEqual(fixture.controls.counts(), before);
    ok(await reconstructed.close());
  } finally {
    try {
      await fixture.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function agentUIScenario(signal, wrapView = (view) => view) {
  const fixture = createFakeFixture();
  try {
    const command = fixture.connect(() => {});
    const held = fixture.controls.holdNextCompletion();
    const accepted = ok(await command.submit({ session: fixture.samples.a, hostOperationId }, signal));
    await wait(held.entered, signal);
    let completed = false;
    held.completed.then(() => { completed = true; });
    const aValues = [];
    const bValues = [];
    const aSeen = Promise.withResolvers();
    const bSeen = new Map([1, 2].map((sequence) => [sequence, Promise.withResolvers()]));
    const aInput = viewOptions(fixture, (sequence) => { aValues.push(sequence); aSeen.resolve(); });
    const bInput = viewOptions(fixture, (sequence) => { bValues.push(sequence); bSeen.get(sequence)?.resolve(); });
    const pending = structuredClone(fixture.samples.approval);
    pending.target.tool = { nativeToolCallId: 'native-associated-tool' };
    aInput.pending = structuredClone(pending);
    bInput.pending = structuredClone(pending);
    bInput.correlation = structuredClone(correlation);
    const a = wrapView(openAgentView(aInput), command, fixture);
    const b = openAgentView(bInput);
    fixture.controls.emit(1);
    await wait(Promise.all([aSeen.promise, bSeen.get(1).promise]), signal);
    ok(await a.close());
    bInput.onProgress = () => { throw new Error('Mutated client callback.'); };
    const bCount = bValues.length;
    fixture.controls.emit(2);
    await wait(bSeen.get(2).promise, signal);
    assert.deepEqual(aValues, [1]);
    assert.deepEqual(bValues.slice(bCount), [2], 'replacement view observes held work after old view cleanup');
    assert.equal(completed, false, 'view cleanup does not complete held native work');
    const lookup = await command.recover(accepted).reconcile(signal);
    assert.equal(lookup.kind, 'ok', 'view cleanup must leave command lookup available');
    assert.equal(ok(lookup).observation.kind, 'accepted');

    assert.deepEqual(b.presentation, { correlation, nativePending: pending,
      capabilities: [{ kind: 'supported' },
        { kind: 'unsupported', reason: 'Native checkpoint is absent.' },
        { kind: 'unavailable', reason: 'Host account is disconnected.' }] });
    const nativeReply = replyFor(pending);
    bInput.pending.target.nativeApprovalId = correlation.requestId;
    bInput.pending.target.tool.nativeToolCallId = 'client-tool';
    bInput.pending.choices[0].nativeChoiceId = 'client-choice';
    bInput.correlation.requestId = 'client-request';
    b.presentation.nativePending.target.nativeApprovalId = correlation.requestId;
    b.presentation.nativePending.target.tool.nativeToolCallId = 'presentation-tool';
    b.presentation.nativePending.choices[0].nativeChoiceId = 'presentation-choice';
    fixture.controls.pending(pending);
    const wrong = structuredClone(nativeReply);
    wrong.target.nativeApprovalId = correlation.requestId;
    const before = fixture.controls.counts();
    const rejected = await b.reply(wrong, command, signal);
    assert.deepEqual(rejected, { kind: 'error', error: { code: 'target-mismatch' } });
    assert.deepEqual(fixture.controls.counts(), before, 'host ID substitution rejects before backend work');
    held.release();
    await wait(held.completed, signal);
    const replied = ok(await b.reply(nativeReply, command, signal));
    assert.equal(replied.observation.kind, 'conclusive');
    assert.deepEqual(replied.observation.result.continuation, nativeReply,
      'private native approval, associated tool, and choice survive client mutations');
    ok(await b.close());
    const found = ok(await command.recover(accepted).reconcile(signal));
    assert.equal(found.observation.kind, 'conclusive', 'command owner survives both view closes');
    assert.deepEqual(fixture.controls.counts(),
      { dispatchAttempts: 2, acceptedEffects: 2, lookupCalls: 2, transportCloses: 2 });
  } finally {
    await fixture.dispose();
  }
}

test('Crew reconstructs persisted command ownership', { timeout: 5000 }, async ({ signal }) => {
  await crewScenario(signal);
});

test('AgentUI keeps view and command ownership separate', { timeout: 5000 }, async ({ signal }) => {
  await agentUIScenario(signal);
});

test('host controls reject unsafe resubmission', { timeout: 5000 }, async ({ signal }) => {
  let badAction;
  await assert.rejects(crewScenario(signal, (owner, fixture) => ({ ...owner,
    async execute(request, operationSignal) {
      const unsafe = fixture.connect(() => {});
      const snapshot = ok(await unsafe.submit(request, operationSignal));
      assert.equal(snapshot.observation.kind, 'conclusive', 'broken send enters after first completion');
      badAction = fixture.controls.counts();
      return snapshot;
    },
  })), { code: 'ERR_ASSERTION', message: /host must not resubmit saved unknown work/ });
  assert.equal(badAction.dispatchAttempts, 2);
  assert.equal(badAction.acceptedEffects, 2);
  assert.equal(badAction.lookupCalls, 0);
});

test('host controls reject command closure with a view', { timeout: 5000 }, async ({ signal }) => {
  let badAction;
  await assert.rejects(agentUIScenario(signal, (view, command, fixture) => ({ ...view,
    async close() {
      const result = await view.close();
      await command.close();
      badAction = fixture.controls.counts();
      return result;
    },
  })), { code: 'ERR_ASSERTION', message: /view cleanup must leave command lookup available/ });
  assert.equal(badAction.transportCloses, 2);
  assert.equal(badAction.acceptedEffects, 1);
});
