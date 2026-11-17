import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { admittedPath, evidenceOf, observeSource, selectorFor, verifySource } from './inventory.mjs';

// One Legacy-history question: does the pinned public read path reject, or merely read past, one malformed JSON
// tail record? The answer is one of OUTCOMES and nothing else: no corruption, compatibility or continuation class.
/**
 * @typedef {'healthy'|'tail'|'whole'|'absent-id'|'absent-path'} Control   one fresh frozen reader home each
 * @typedef {{ method: string, params: object, reply: object }} ReadStep   one public request and its parsed reply, never thrown
 * @typedef {{ key: string, informative: boolean, tail: object|null, sameAsHealthy: boolean, sameAsAbsentPath: boolean }} StepOutcome
 *   facts only; `informative` means the healthy control answered this step
 * @typedef {{ stage: 'creator', acquisition: 'partial'|'unparsed', failure: string|null }} PreconditionFailure
 * @typedef {{ outcome: 'successful-reads-uncertified'|'bounded-public-rejection', compared: StepOutcome[], meaning: string }
 *   | { outcome: 'inconclusive', reasons: string[], precondition?: PreconditionFailure, compared?: StepOutcome[] }} Conclusion
 */
export const MALFORMED_RECORD = Buffer.from('{invalid-json\n');
export const CONTROLS = Object.freeze(['healthy', 'tail', 'whole', 'absent-id', 'absent-path']);
export const OUTCOMES = Object.freeze(['successful-reads-uncertified', 'bounded-public-rejection', 'inconclusive']);
// Never created by any fixture; a well-formed UUID so a rejection is about absence, not ID syntax.
export const ABSENT_ID = '00000000-0000-4000-8000-000000000000';
const TOKEN = /^sessions\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.jsonl$/;
const plainJsonl = (bytes) => bytes?.length > 0 && bytes.length <= 4 * 1024 * 1024 && bytes[0] === 0x7b && bytes.at(-1) === 0x0a;

/** Creator (mode prepare-legacy): one public Legacy thread, one completed synthetic turn, drained, then one export. */
export async function legacyCreate({ client, until, root, fs }) {
  const cwd = '/tmp/project';
  const modelProvider = 'fixture';
  const { thread } = await client.call('thread/start', { cwd, modelProvider, approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'legacy' });
  assert.equal(thread.historyMode, 'legacy', 'Public start must honor the experimental Legacy history option');
  const { turn } = await client.call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'legacy', text_elements: [] }] });
  const completed = await until(() => client.events.find((event) => event.method === 'turn/completed' && event.params.turn.id === turn.id), 'legacy turn');
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(completed.params.threadId, thread.id);
  const { thread: read } = await client.call('thread/read', { threadId: thread.id, includeTurns: false });
  assert.equal(read.id, thread.id);
  assert.equal(read.historyMode, 'legacy', 'Creator read-back keeps Legacy history');
  assert(typeof read.path === 'string' && read.path.startsWith(`${root}/`), 'Native-returned rollout path inside the synthetic home');
  if (thread.path !== null) assert.equal(read.path, thread.path, 'One native rollout path');
  await client.stop();
  const capture = observeSource(root, selectorFor('prepare-legacy'), { fs, stage: 'legacy creator capture' });
  const settled = verifySource(capture, 'legacy creator settled after drain');
  const token = read.path.slice(root.length + 1);
  assert.match(token, TOKEN, 'Plain JSONL rollout under sessions');
  const bytes = capture.entries.get(token)?.bytes;
  assert(plainJsonl(bytes), 'Rollout must be bounded, start a JSON object and end in one newline before a record is appended');
  const record = { name: 'legacy', id: thread.id, cwd, modelProvider, path: token, witness: { startedTurnId: turn.id,
    completedTurnId: completed.params.turn.id, status: 'completed', userText: 'legacy', agentText: 'synthetic discovery fixture' } };
  return { record, rollout: bytes.toString('base64'), creator: { startHistoryMode: thread.historyMode, readHistoryMode: read.historyMode,
    startPath: thread.path, readPath: read.path, capture: evidenceOf(capture), settled: settled.counters, rootChanges: settled.rootChanges },
    protocol: { transcript: client.transcript, notifications: client.events } };
}

/** Host: the five frozen source contents. Only the rollout token is ever written; no SQLite or projection exists. */
export function legacySources({ record, rollout }) {
  assert.match(record.path, TOKEN);
  const native = Buffer.from(rollout, 'base64');
  assert(plainJsonl(native), 'Exported native rollout bytes');
  return { healthy: native, tail: Buffer.concat([native, MALFORMED_RECORD]), whole: MALFORMED_RECORD, 'absent-id': native, 'absent-path': null };
}

/**
 * Reader (mode legacy-read): the fixed public sequence. Replies are retained, never thrown: every step is dispatched.
 * Only absent-id changes a request (the never-created ID); absent-path asks the native path in a home without it.
 */
export async function legacyReads({ client, control, record, root, inventory, config, report }) {
  assert(CONTROLS.includes(control), 'Known Legacy control');
  assert.notEqual(record.id, ABSENT_ID);
  assert(inventory.entries.every((entry) => !/\.sqlite|thread_history/.test(entry.token)), 'No original SQLite or projected history');
  assert.deepEqual(inventory.entries.filter((entry) => entry.candidate).map((entry) => entry.token), control === 'absent-path' ? [] : [record.path]);
  const threadId = control === 'absent-id' ? ABSENT_ID : record.id;
  Object.assign(report, { control, id: threadId, token: record.path, sequence: 'incomplete', steps: [],
    configSha256: createHash('sha256').update(JSON.stringify(config)).digest('hex') });
  const step = async (method, params) => {
    const entry = { method, params };
    report.steps.push(entry);
    entry.reply = await client.rpc(method, params);
    return entry.reply;
  };
  const pages = async (method, params) => {
    const cursors = new Set();
    for (let page = 0, cursor; page < 8; page++) {
      const reply = await step(method, { ...params, limit: 1, ...(cursor ? { cursor } : {}) });
      const next = reply.result?.nextCursor;
      if (reply.error || next === null) return;
      if (typeof next !== 'string' || !next || next.length >= 512 || cursors.has(next)) break;
      cursors.add(cursor = next);
    }
    report.pageRefusal ??= method;
  };
  await step('getConversationSummary', { rolloutPath: admittedPath(root, record.path, inventory.entries, control === 'absent-path') });
  await step('thread/read', { threadId, includeTurns: false });
  await step('thread/read', { threadId, includeTurns: true });
  await pages('thread/turns/list', { threadId, sortDirection: 'asc', itemsView: 'summary' });
  await pages('thread/items/list', { threadId, sortDirection: 'asc' });
  report.sequence = 'complete';
  return report;
}

const branch = (reply) => reply && typeof reply === 'object' && Object.hasOwn(reply, 'result') !== Object.hasOwn(reply, 'error');
const rejection = (reply) => Number.isInteger(reply?.error?.code) && typeof reply.error.message === 'string';
const settledClient = (client) => client.closed && !client.stderr.truncated;
/** Steps keyed by method, read shape and ordinal, so opaque native cursors never misalign controls. */
function keyed(steps) {
  const seen = {};
  return new Map(steps.map((step) => {
    const kind = `${step.method}${step.params.includeTurns ? ' turns' : ''}`;
    seen[kind] = (seen[kind] ?? 0) + 1;
    return [`${kind} #${seen[kind]}`, step.reply];
  }));
}
/** Host: the only conclusion site. Every gate failure is inconclusive; a tail rejection or success says nothing more. */
export function legacyConclusion(prepared, readers, root = '/root/.codex') {
  if (prepared.acquisition) return { outcome: 'inconclusive', reasons: ['creator precondition'],
    precondition: { stage: 'creator', acquisition: prepared.acquisition, failure: prepared.failure?.message ?? null } };
  const { record, drain } = prepared;
  const reasons = [];
  const need = (condition, reason) => { if (!condition) reasons.push(reason); };
  need(drain?.length === 1 && drain.every(settledClient), 'creator drain and stderr');
  for (const control of CONTROLS) {
    const reader = readers[control];
    need(!reader?.acquisition, `${control} acquisition`);
    need(reader?.preservationSummary && reader.inferenceRequests === 0 && !reader.failure && !reader.progressTruncated, `${control} harness`);
    need(reader?.drain?.length === 1 && reader.drain.every(settledClient), `${control} drain and stderr`);
    need(reader?.legacy?.sequence === 'complete' && !reader.legacy.pageRefusal && reader.legacy.steps.every((step) => branch(step.reply)), `${control} sequence`);
    need(reader?.legacy?.configSha256 === readers.healthy?.legacy?.configSha256, `${control} configuration`);
  }
  if (reasons.length) return { outcome: 'inconclusive', reasons };
  const [healthy, tail, whole, absentId, absentPath] = CONTROLS.map((control) => keyed(readers[control].legacy.steps));
  const summary = healthy.get('getConversationSummary #1').result?.summary;
  const thread = healthy.get('thread/read #1').result?.thread;
  const loaded = healthy.get('thread/read turns #1').result?.thread?.turns ?? [];
  const pages = (method) => [...healthy].filter(([key]) => key.startsWith(method)).flatMap(([, reply]) => reply.result?.data ?? []);
  const witness = record.witness;
  // Saved history may come from the loaded read or the turn/item pages; either must hold the exact turn and both messages.
  const turns = [...loaded, ...pages('thread/turns/list')];
  const saved = [...loaded.flatMap((turn) => (turn.items ?? []).map((item) => ({ turnId: turn.id, item }))), ...pages('thread/items/list')]
    .filter((entry) => entry.turnId === witness.completedTurnId).map((entry) => entry.item);
  need(summary?.conversationId === record.id && summary.path === `${root}/${record.path}`, 'healthy path summary identity');
  need(thread?.id === record.id && thread.historyMode === 'legacy' && thread.path === `${root}/${record.path}` && thread.turns?.length === 0, 'healthy Legacy metadata');
  need(turns.some((turn) => turn.id === witness.completedTurnId && turn.status === 'completed'), 'healthy saved turn');
  need(saved.some((item) => item.type === 'userMessage' && item.content?.some((part) => part.text === witness.userText))
    && saved.some((item) => item.type === 'agentMessage' && item.text === witness.agentText), 'healthy turn and message association');
  need([...healthy].some(([key, reply]) => reply.result && rejection(whole.get(key))), 'whole-file control rejected publicly');
  // absent-id holds the healthy rollout, so its summary must still name the native ID while the never-created ID is rejected.
  need(absentId.get('getConversationSummary #1').result?.summary?.conversationId === record.id && rejection(absentId.get('thread/read #1')), 'absent-id control rejected');
  need(rejection(absentPath.get('getConversationSummary #1')), 'absent-path control rejected');
  if (reasons.length) return { outcome: 'inconclusive', reasons };
  // Only steps the healthy control answered can speak about the tail record; others are retained but uninformative.
  const compared = [...healthy].map(([key, reply]) => ({ key, informative: Boolean(reply.result), tail: tail.get(key) ?? null,
    sameAsHealthy: JSON.stringify(tail.get(key)) === JSON.stringify(reply),
    sameAsAbsentPath: rejection(tail.get(key)) && JSON.stringify(tail.get(key).error) === JSON.stringify(absentPath.get(key)?.error) }));
  const informative = compared.filter((step) => step.informative);
  if (informative.some((step) => rejection(step.tail))) return { outcome: 'bounded-public-rejection', compared,
    meaning: 'The public read path returned a well-formed error for this file where the healthy control succeeded. No reason is inferred.' };
  const [tailSummary, tailThread] = ['getConversationSummary #1', 'thread/read #1'].map((key) => tail.get(key)?.result);
  if (!informative.every((step) => step.tail?.result) || tailSummary?.summary?.conversationId !== record.id || tailThread?.thread?.id !== record.id) {
    return { outcome: 'inconclusive', reasons: ['tail replies do not align with the healthy control'], compared };
  }
  return { outcome: 'successful-reads-uncertified', compared, meaning: 'Every informative public read succeeded; success does not certify that every saved record is valid JSON.' };
}
