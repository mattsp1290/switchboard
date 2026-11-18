import { concludeNativeProof, runNativeProof } from './native-proof.mjs';

// x9av native proof: the compiled private Codex execution module against the pinned app-server and a synthetic loopback
// Responses service (X1-X9). Separate from qualify.mjs and sessions-proof.mjs so their pins and guarded closures stay unchanged.
const result = await runNativeProof({ kind: 'execution', scenarios: ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9'],
  compiled: ['execution'] });
// The only conclusion site, after the full report is printed and cleanup is proved. Checks cover what the module claims
// from qualified native evidence, including usage and the error-reply mapping that X1 and X7 qualified on both
// architectures. Opaque signals (turn/started, error willRetry) are pinned but never asserted here; the native resume while
// another app-server holds the thread is recorded raw only. Every native error reply is in each report's raw.nativeErrors.
const { X1, X2, X3, X4, X5, X6, X7, X8, X9 } = result.reports;
// Architecture-independent pin: outcomes, counts, booleans and native-reported usage only; never IDs, paths, timestamps or hashes.
// Printed before any assertion so a failing run still shows the object to compare. Arrival-order and timing facts stay raw:
// X1.snapshot is conclusive only when turn/completed beats the turn/start reply; thread/started reaches the session only when
// read after attach() registers the thread from the thread/start reply, else it is published unrouted on the execution
// stream; X6.inferenceBeforeExit counts inference inside a 500 ms window; X7's event count was that same thread/started race.
const pinned = { X1: { eventKinds: X1.eventKinds, nativeMethods: X1.nativeMethods?.filter((method) => method !== 'thread/started'),
  turnStartedSeen: X1.turnStartedSeen, usageSeen: X1.usageSeen, usage: X1.usage }, X2: { resumeTurns: X2.resumeTurns },
  X5: { unsubscribe: X5.close?.unsubscribe ?? null, reopen: X5.reopen, afterReopen: X5.afterReopen ?? null },
  X6: { completion: X6.completion }, X7: { snapshot: X7.snapshot, completion: X7.completion, error: X7.raw.error },
  X8: { errorNotification: X8.errorNotification } };
const checks = {
  harness: Object.values(result.reports).every((report) => report.failures.length === 0 && report.heldAtEnd === 0),
  X1: X1.completion === 'completed' && ['accepted', 'conclusive'].includes(X1.snapshot) && X1.inference.answer === 1
    && X1.usageSeen && X1.usage?.evidence === 'qualified',
  X2: X2.resume === 'resumed' && X2.sameId && X2.resumeInference === 0 && X2.completion === 'completed' && X2.prefixPreserved,
  X3: X3.b === 'completed' && X3.aPendingAfterB && X3.a === 'completed',
  X4: X4.accepted === 'accepted' && X4.terminal === 'interrupted' && X4.busyDuringHold === 'busy' && X4.requestsDuringHold === 0
    && X4.independent === 'completed' && X4.close?.released === false && X4.close?.interrupt === 'replied'
    && X4.busyAfterClose === 'busy' && X4.requestsAfterClose === 0 && X4.heldAfterExit === X4.heldDuringHold - 1
    && X4.admittedAfter === 'resumed' && X4.after === 'completed' && X4.holdInference === 1,
  X5: X5.close?.released === false && X5.reopen === 'busy' && X5.reopenRequests === 0,
  X6: X6.snapshot === 'outcome-unknown' && X6.turnStartWrites === 1 && X6.retainedBeforeExit === 1 && X6.releasedAfterExit
    && X6.resume === 'resumed' && X6.inferenceAfterResume === X6.inferenceBeforeExit && X6.inferenceBeforeExit <= 1,
  X7: X7.turnStartWrites === 1 && X7.snapshot === 'conclusive' && X7.completion === 'rejected',
  X8: X8.terminal === 'failed' && X8.deltaSeen && X8.disconnectInference === 1,
  X9: X9.aborted === 'error:closed' && X9.detached === 1 && X9.heldAfterAbort === 0 && X9.freshCreate === 'ok',
};
await concludeNativeProof('execution', pinned, checks);
