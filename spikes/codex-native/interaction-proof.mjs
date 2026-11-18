import { concludeNativeProof, runNativeProof } from './native-proof.mjs';

// 118i native proof: the compiled private Codex interaction bridge over the execution module against the pinned app-server
// and a synthetic loopback Responses service that emits a real command approval (N1-N9, N6 folded into N1). Separate from
// execution-proof.mjs so its pin and guarded closure stay unchanged.
const result = await runNativeProof({ kind: 'interaction', scenarios: ['N1', 'N2', 'N3', 'N4', 'N5', 'N7', 'N8', 'N9'],
  sources: ['src/adapters/codex/interaction.ts', 'src/core/interaction.ts'], compiled: ['execution', 'interaction'] });
// The only conclusion site, after the full report is printed and cleanup is proved. Checks cover only what the bridge
// claims: one decision frame per host reply and none otherwise, single use, declined-only no-effect, lost/expired/
// withdrawn without a decision, interrupt requested, transport survival and writer release only on exit. Native reactions
// (terminal after interrupt or expiry, accept or cancel item status, replay after resume, advertised tools) are pinned,
// never asserted; native notification order is recorded raw only. Every native error reply is in each report's raw.nativeErrors.
const { N1, N2, N3, N4, N5, N7, N8, N9 } = result.reports;
// Architecture-independent pin: outcomes, statuses, counts and booleans only; never IDs, paths or timestamps. Printed before
// any assertion so a failing run still shows the object to compare. Arrival order stays raw (report.order, withdrawnBy):
// serverRequest/resolved, item/completed and turn/completed come from separate native sources, and 0.169 already showed
// unstable cross-source order (execution X1 thread/started), so order is evidence, not a pinned claim. Presence within
// a generous window (terminal within 5 s, command started within 5 s, nothing replayed after 1 s, N8 within 6 s) stays
// pinned: it records whether native reacts at all, and a native that held the turn would change it.
const requests = (report) => report.serverRequests.map(({ method, idType, approvalId, availableDecisions }) =>
  ({ method, idType, approvalId, offered: availableDecisions?.map((d) => (typeof d === 'string' ? d : Object.keys(d)[0])) ?? null }));
const pinned = {
  N1: { choices: N1.choices, item: N1.item, terminal: N1.terminal, requests: requests(N1), markerInference: N1.markerInference },
  N2: { terminal: N2.terminal, item: N2.item, marker: N2.marker, markerInference: N2.markerInference },
  N3: { concurrentA: N3.concurrentA, a: N3.a },
  N4: { terminalWithin5s: N4.terminalWithin5s, terminal: N4.terminal, settlements: N4.settlements, item: N4.item,
    markerInference: N4.markerInference },
  N5: { completion: N5.completion, resumedLastTurn: N5.resumedLastTurn, resumedItems: N5.resumedItems,
    requestsAfterResume: N5.requestsAfterResume, reappeared: N5.reappeared ?? null },
  N7: { commandStarted: N7.commandStarted, terminal: N7.terminal, item: N7.item, marker: N7.marker },
  N8: { candidates: N8.candidates, notAdvertised: N8.notAdvertised ?? false, reactions: N8.reactions, refusedMethods: N8.refusedMethods },
  N9: { terminalWithin5s: N9.terminalWithin5s, terminal: N9.terminal, item: N9.item },
};
const statuses = ['completed', 'interrupted', 'failed'];
const decisionNames = (request) => (request?.availableDecisions ?? [])
  .map((d, index) => (typeof d === 'string' ? d : `${Object.keys(d)[0]}:${index}`));
const approvalMethod = 'item/commandExecution/requestApproval';
const checks = {
  harness: Object.values(result.reports).every((report) => report.failures.length === 0 && report.heldAtEnd === 0),
  // Choices are the request's own availableDecisions; a not-offered choice is refused locally with nothing written.
  N1: N1.pendingMethod === approvalMethod && JSON.stringify(N1.choices) === JSON.stringify(decisionNames(N1.serverRequests[0]))
    && N1.notOffered === 'error:choice-mismatch' && N1.framesAfterNotOffered === 0 && N1.reply === 'ok'
    && N1.duplicate === 'error:duplicate-interaction' && JSON.stringify(N1.decisionFrames) === '["cancel"]'
    && N1.settlements?.join() === 'replied' && N1.marker === false && statuses.includes(N1.terminal)
    && N1.item?.includes('declined') === N1.bridge?.includes('observed:item/completed:known:qualified'),
  N2: N2.reply === 'ok' && N2.duplicate === 'error:duplicate-interaction' && JSON.stringify(N2.decisionFrames) === '["accept"]'
    && statuses.includes(N2.terminal),
  N3: N3.b === 'completed' && N3.aPendingAfterB && N3.read === 'result' && N3.reply === 'ok' && statuses.includes(N3.a)
    && N3.closeReasons?.every((reason) => reason === 'caller-close'),
  N4: N4.interrupt === 'replied' && N4.settlements?.join() === 'withdrawn' && N4.decisionFrames === 0 && N4.marker === false
    && N4.independent === 'completed',
  N5: N5.heldBeforeKill === 1 && N5.heldAfterExit === 0 && N5.settlements?.join() === 'lost' && N5.replyFramesBeforeResume === 0
    && N5.lateReply === 'error:stale-interaction' && N5.marker === false && N5.resume === 'resumed' && N5.inferenceAfterResume === 0,
  N7: N7.reply === 'ok' && N7.interrupt === 'replied' && statuses.includes(N7.terminal),
  N8: N8.errorOnlyRefusals === true,
  N9: N9.settlements?.join() === 'expired' && N9.decisionFrames === 0 && N9.errorFrames?.includes(-32000) && N9.marker === false
    && N9.independent === 'completed',
};
await concludeNativeProof('interaction', pinned, checks);
