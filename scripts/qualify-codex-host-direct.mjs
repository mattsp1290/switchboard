// Explicit owner-run live gate. Reports contain only synthetic scenario labels and bounded statuses/counts.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, cp, lstat, mkdir, readdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { hostVariables } from './live-baseline-engines.mjs';
import { qualificationImage } from './support/qualification-image.mjs';
import { dedicatedHome, scopedCommand, scopedFileChange, verifyFinalFiles, stopChildren, closeAdapter, qualificationPassed, qualificationFingerprint, targetTerminals, waitForTargetTerminals, scenarioDeadline } from './support/codex-host-qualification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });
class ScenarioFailure extends Error {}
export const exists = async (path, inspect = access) => { try { await inspect(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const installedBinary = join(root, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');

export async function launch(request, extra, children, nativeTerminals, nativeDecisions, nativeInterrupts, nativeTurns) {
  const child = spawn(request.executable, [...request.args.slice(1), ...extra], { cwd: request.cwd, env: request.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => { child.once('close', resolve); });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  const group = {
    alive() {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    },
    signal(signal) {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    },
  };
  children.push({ exited, group });
  const patches = new Map();
  const fileApprovals = new Map();
  let fileEvidenceOverflow = false;
  const patchKey = (params, itemId) => JSON.stringify([params.threadId, params.turnId, itemId]);
  return { processExit: exited, channel: {
    listen(sink) {
      const decoder = new StringDecoder('utf8');
      let buffered = '';
      const data = (bytes) => {
        buffered += decoder.write(bytes);
        let newline;
        while ((newline = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (line.length <= 8388608) {
            try {
              const frame = JSON.parse(line);
              const interrupted = nativeInterrupts.find((request) => Object.is(request.requestId, frame.id));
              if (interrupted && Object.hasOwn(frame, 'result')) interrupted.acknowledged = true;
              const params = frame.params;
              if (frame.method === 'item/fileChange/requestApproval') {
                if (fileApprovals.size >= 16) fileEvidenceOverflow = true;
                else fileApprovals.set(frame.id, params);
              }
              const item = params?.item;
              if ((frame.method === 'item/started' || frame.method === 'item/completed') && item?.type === 'fileChange') {
                const key = patchKey(params, item.id);
                if (!patches.has(key) && patches.size >= 16) fileEvidenceOverflow = true;
                else patches.set(key, item);
              } else if (frame.method === 'item/fileChange/patchUpdated') {
                const key = patchKey(params, params.itemId);
                if (!patches.has(key) && patches.size >= 16) fileEvidenceOverflow = true;
                else patches.set(key, { type: 'fileChange', id: params.itemId, changes: params.changes });
              }
              const status = frame.params?.turn?.status;
              if (frame.method === 'turn/completed' && ['completed', 'failed', 'interrupted'].includes(status) && nativeTerminals.length < 16) nativeTerminals.push({ threadId: frame.params.threadId, turnId: frame.params.turn.id, status });
            } catch { /* The adapter remains the authority on malformed protocol input. */ }
          }
        }
        if (buffered.length > 8388608) buffered = '';
        for (let start = 0; start < bytes.length; start += 16777215) sink.data(bytes.subarray(start, start + 16777215));
      };
      const ended = () => sink.ended('process-exit');
      child.stdout.on('data', data); child.once('close', ended);
      return () => { child.stdout.off('data', data); child.off('close', ended); };
    },
    write(bytes, signal) {
      if (signal.aborted) return Promise.reject(new Error('aborted'));
      try {
        const frame = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (fileEvidenceOverflow && ['accept', 'acceptForSession'].includes(frame.result?.decision)) return Promise.reject(new Error('file-evidence-overflow'));
        const fileApproval = fileApprovals.get(frame.id);
        if (fileApproval && frame.result?.decision === 'acceptForSession') return Promise.reject(new Error('file-decision-mismatch'));
        if (fileApproval && ['accept', 'acceptForSession'].includes(frame.result?.decision)) {
          const pending = { kind: 'pending', calls: [], approvals: [{ request: { data: { method: 'item/fileChange/requestApproval', params: fileApproval } },
            target: { tool: { nativeToolCallId: fileApproval.itemId } } }] };
          if (fileEvidenceOverflow || !scopedFileChange(pending, patches.get(patchKey(fileApproval, fileApproval.itemId)), join(request.cwd, 'file.txt'))) {
            return Promise.reject(new Error('out-of-scope-file-change'));
          }
        }
        if (typeof frame.result?.decision === 'string' && nativeDecisions.length < 16) nativeDecisions.push({ requestId: frame.id, decision: frame.result.decision });
        if (frame.method === 'turn/interrupt' && nativeInterrupts.length < 16) nativeInterrupts.push({ requestId: frame.id, threadId: frame.params?.threadId, turnId: frame.params?.turnId, acknowledged: false });
        if (frame.method === 'turn/start' && Array.isArray(frame.params?.input) && nativeTurns.length < 16) nativeTurns.push({ images: frame.params.input.filter((item) => item.type === 'image' && typeof item.url === 'string').map((item) => createHash('sha256').update(item.url).digest('hex')) });
      } catch { return Promise.reject(new Error('unrecognized-outgoing-frame')); }
      return new Promise((resolve, reject) => child.stdin.write(bytes, (error) => error ? reject(new Error('write failed')) : resolve()));
    },
  } };
}
export async function snapshotQualificationBinary(source, directory) {
  const path = join(directory, 'codex');
  await copyFile(source, path);
  await chmod(path, 0o500);
  return path;
}
async function main() {
  const stopped = new AbortController();
  const onStop = () => stopped.abort();
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  let cleanupConfirmed = true;
  const report = { date: new Date().toISOString(), nativeVersion: '0.169.0', binarySha256: null, login: 'not-covered', scenarios: [] };
  const output = resolve(new URL(import.meta.url).searchParams.get('report') ?? process.env.SWITCHBOARD_CODEX_HOST_REPORT ?? join(root, '.audit/codex-host-direct.json'));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'switchboard-codex-direct-')));
  let home = process.env.CODEX_HOME;
  let binary;
  try {
    home = await dedicatedHome(home, join(homedir(), '.codex'), join(userInfo().homedir, '.codex'));
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('unsupported-platform');
    if (!(await exists(installedBinary))) throw new Error('native-binary-missing');
    binary = await snapshotQualificationBinary(installedBinary, scratch);
    // Always emit into a fresh directory; a noEmit/declaration-only config cannot certify stale JS.
    const runtimeRoot = join(scratch, 'runtime'); await mkdir(runtimeRoot);
    await copyFile(join(root, 'package.json'), join(runtimeRoot, 'package.json'));
    const buildOptions = ['--outDir', join(runtimeRoot, 'dist'), '--noEmit', 'false', '--emitDeclarationOnly', 'false', '--incremental', 'false'];
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), ...buildOptions], { cwd: root, timeout: 60000, maxBuffer: 1048576 });
    const hostEntry = join(runtimeRoot, 'dist/adapters/codex/index.js'); await access(hostEntry);
    report.build = 'fresh-isolated-root-tsc';
    report.sourceMode = 'private-source-snapshot';
    report.buildOptions = ['noEmit:false', 'emitDeclarationOnly:false', 'incremental:false'];
    report.fingerprint = await qualificationFingerprint(root, runtimeRoot);
    report.nodeVersion = process.version;
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }).trim();
    if (version !== 'codex-cli 0.169.0') throw new Error('wrong-native-version');
    report.binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
    const shellHome = join(scratch, 'shell-home'); await mkdir(shellHome);
    const variables = hostVariables('host/codex', { path: process.env.PATH ?? '', home: shellHome, codexHome: home });
    const login = spawnSync(binary, ['login', 'status'], { env: variables, encoding: 'utf8',
      timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] });
    if (login.status !== 0 || !`${login.stdout}${login.stderr}`.includes('ChatGPT')) throw new Error('chatgpt-login-required');
    report.login = 'chatgpt';
    const { codexHostAdapter } = await import(pathToFileURL(hostEntry).href);
    async function scenario(name, body) {
      if (stopped.signal.aborted) { report.scenarios.push({ id: name, status: 'not-covered', reason: 'qualification-stopped' }); return; }
      const cwd = join(scratch, name);
      const children = [];
      const nativeTerminals = [];
      const nativeDecisions = [];
      const nativeInterrupts = []; const nativeTurns = [];
      let adapter;
      const events = [];
      const eventWaiters = new Set();
      const observations = [];
      const deadline = scenarioDeadline(stopped.signal);
      const signal = deadline.signal;
      const result = { id: name, status: 'failed' };
      const expectedFiles = [];
      const expectFile = fact => { expectedFiles.push(fact); };
      try {
        await mkdir(cwd);
        const sqliteHome = join(scratch, `${name}-sqlite`); const logDir = join(scratch, `${name}-logs`);
        await mkdir(sqliteHome); await mkdir(logDir);
        const extra = ['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`, '-c', `log_dir=${JSON.stringify(logDir)}`];
        const opened = await codexHostAdapter.open({ launch: { kind: 'spawn', spawn: (request) => launch(request, extra, children, nativeTerminals, nativeDecisions, nativeInterrupts, nativeTurns) },
          subagents: 'off', builtInTools: ['shell'], environment: { variables, nativeConfig: { home, cwd, executable: binary, sqliteHome, logDir,
            sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', activity: 'items' } } }, signal);
        if (opened.kind !== 'ok') {
          result.openCode = opened.error.code;
          throw new ScenarioFailure('open-failed');
        }
        adapter = opened.value;
        adapter.events.subscribe((event) => { events.push(event); for (const waiter of eventWaiters) waiter(event); });
        const activity = (predicate) => {
          const previous = events.find(predicate);
          if (previous) return Promise.resolve(previous);
          return new Promise((resolve, reject) => {
            const dispose = () => { eventWaiters.delete(onEvent); signal.removeEventListener('abort', onAbort); };
            const onEvent = (event) => { if (predicate(event)) { dispose(); resolve(event); } };
            const onAbort = () => { dispose(); reject(new ScenarioFailure('activity-deadline')); };
            eventWaiters.add(onEvent); signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
        };
        const request = { signal, hostOperationId: name, recordIntent: () => {}, onObservation: (event) => { observations.push(event); } };
        await body({ expectFile, adapter, cwd, events, activity, observations, signal, request, result, nativeTerminals, nativeDecisions, nativeInterrupts, nativeTurns });
        result.nativeTerminals = nativeTerminals.map((terminal) => terminal.status);
        if (result.status === 'failed') result.status = 'passed';
      } catch (error) {
        result.nativeTerminals = nativeTerminals.map((terminal) => terminal.status);
        result.reason = error instanceof ScenarioFailure ? error.message : 'scenario-failed';
      } finally {
        deadline.dispose();
        try {
          if ((await closeAdapter(adapter)) !== 'closed') { result.status = 'failed'; result.reason = 'close-failed'; }
        } catch { result.status = 'failed'; result.reason = 'close-failed'; }
        finally {
          if (!(await stopChildren(children))) { cleanupConfirmed = false; result.status = 'failed'; result.reason = 'cleanup-unconfirmed'; }
          if (result.status === 'passed' || result.status === 'not-covered') {
            try { if (!(await verifyFinalFiles(expectedFiles))) { result.status = 'failed'; result.reason = 'marker-mismatch'; } }
            catch { result.status = 'failed'; result.reason = 'filesystem-inspection-failed'; }
          }
          report.scenarios.push(result);
        }
      }
    }
    const commandPrompt = (marker) => `Use the shell tool to run /usr/bin/touch ${marker}, with shell=/bin/sh and login=false so the command uses a non-login /bin/sh -c invocation. This is a disposable qualification marker. Request escalated permissions with sandbox_permissions=require_escalated and ask the user for approval. Do not use another tool, do not work around the read-only sandbox, and do not write anything before the approval is answered. After the decision, finish without another attempt.`;
    for (const choice of ['accept', 'cancel', 'interrupt']) await scenario(`command-${choice}`, async ({ expectFile, adapter, cwd, activity, observations, signal, request, result, nativeTerminals, nativeDecisions, nativeInterrupts }) => {
      const marker = join(cwd, 'marker');
      const pending = await adapter.run({ ...request, prompt: commandPrompt(marker) });
      if (pending.kind !== 'pending' || pending.approvals.length !== 1) throw new ScenarioFailure('no-approval');
      const approval = pending.approvals[0];
      if (!scopedCommand(pending, cwd, marker)) throw new ScenarioFailure('wrong-approval');
      result.approvals = pending.approvals.length;
      if (choice === 'interrupt') {
        const interrupted = await adapter.interrupt({ timeoutMs: 10000 });
        if (!['interrupted', 'terminal-observed'].includes(interrupted.kind)) throw new ScenarioFailure('interrupt-unconfirmed');
        const settled = await activity((e) => e.kind === 'interaction-settled' && e.settlement.data.kind === 'withdrawn'
          && e.target.nativeApprovalId === approval.target.nativeApprovalId);
        if (!settled) throw new ScenarioFailure('missing-withdrawal');
        const current = await adapter.capabilities.inspect.api.pending(signal);
        if (current.kind !== 'ok' || current.value.approvals.length || current.value.calls.length) throw new ScenarioFailure('pending-remains');
        result.interrupt = interrupted.kind; result.localWithdrawal = settled.settlement.data.by === 'turn/interrupt';
        let terminal = interrupted;
        for (let i = 0; i < 1000 && terminal.kind !== 'terminal-observed' && !signal.aborted; i++) {
          await delay(100); terminal = await adapter.interrupt({ timeoutMs: 100 });
        }
        if (terminal.kind !== 'terminal-observed') throw new ScenarioFailure('interrupt-followup-failed');
        const followup = await adapter.run({ ...request, hostOperationId: `${request.hostOperationId}-followup`, prompt: 'Reply with OK. Do not use tools.' });
        if (followup.kind !== 'complete') throw new ScenarioFailure('interrupt-followup-failed');
        const target = approval.request.data.params;
        const writes = nativeInterrupts.filter((request) => request.threadId === target.threadId && request.turnId === target.turnId);
        result.interruptWriterEntered = writes.length > 0;
        result.interruptAcknowledged = writes.some((request) => request.acknowledged);
        if (!result.interruptWriterEntered || !targetTerminals(nativeTerminals, approval).includes('interrupted')) throw new ScenarioFailure('interrupt-not-written');
        if (nativeDecisions.some(decision => Object.is(decision.requestId, approval.request.data.id))) throw new ScenarioFailure('unexpected-approval-decision');
        result.followupComplete = true;
      } else {
        if (!approval.choices.some((c) => c.nativeChoiceId === choice)) throw new ScenarioFailure('missing-choice');
        const continued = await adapter.continue({ ...request, hostOperationId: `${request.hostOperationId}-answer`,
          answers: [{ formatVersion: 1, kind: 'approval', target: approval.target, nativeChoiceId: choice }] });
        result.choiceWriterEntered = nativeDecisions.some((decision) => Object.is(decision.requestId, approval.request.data.id) && decision.decision === choice);
        if (!result.choiceWriterEntered) throw new ScenarioFailure('choice-not-written');
        if (choice === 'cancel') {
          const declined = Boolean(await activity((e) => e.kind === 'native-item' && e.item.data.method === 'item/completed'
            && e.item.data.params.item?.id === approval.target.tool.nativeToolCallId && e.item.data.params.item.status === 'declined'));
          result.declinedItem = declined; result.segmentKind = continued.kind;
          result.segmentTerminal = observations.findLast((e) => e.kind === 'terminal')?.outcome;
          if (continued.kind === 'failed') {
            result.writeKind = continued.write.kind;
            if (continued.write.kind !== 'outcome-unknown') throw new ScenarioFailure('cancel-write-certainty-mismatch');
          }
          // Reply delivery certainty is separate from the native turn's terminal fact.
          const ended = (await waitForTargetTerminals(nativeTerminals, approval, signal)).some((status) => status === 'interrupted' || status === 'completed');
          result.nativeCancellationObserved = declined && ended;
          if (!declined || !ended || !['complete', 'failed'].includes(continued.kind)) throw new ScenarioFailure('turn-not-complete');
          if ((await adapter.interrupt({ timeoutMs: 100 })).kind !== 'terminal-observed') throw new ScenarioFailure('turn-not-complete');
        } else if (continued.kind !== 'complete') throw new ScenarioFailure('turn-not-complete');
        if (choice === 'accept' && !await activity((e) => e.kind === 'native-item' && e.item.data.method === 'item/completed'
          && e.item.data.params.item?.type === 'commandExecution' && e.item.data.params.item.id === approval.target.tool.nativeToolCallId && e.item.data.params.item.status === 'completed')) throw new ScenarioFailure('missing-command-activity');
      }
      if (await exists(marker) !== (choice === 'accept')) throw new ScenarioFailure('marker-mismatch');
      expectFile({ path: marker, present: choice === 'accept' });
      result.markerPresent = choice === 'accept';
    });
    await scenario('image-4mib', async ({ adapter, request, result, nativeTurns }) => {
      const image = qualificationImage();
      const imageUrl = `data:image/png;base64,${image.toString('base64')}`;
      if ((await adapter.run({ ...request, prompt: 'Briefly describe this image.', images: [{ mediaType: 'image/png', dataUrl: imageUrl }] })).kind !== 'complete') throw new ScenarioFailure('image-failed');
      if ((await adapter.run({ ...request, hostOperationId: 'image-followup', prompt: 'Reply with OK.' })).kind !== 'complete') throw new ScenarioFailure('transport-not-open');
      result.imageWriterVerified = nativeTurns[0]?.images.length === 1 && nativeTurns[0].images[0] === createHash('sha256').update(imageUrl).digest('hex') && nativeTurns[1]?.images.length === 0;
      if (!result.imageWriterVerified) throw new ScenarioFailure('image-not-written');
      result.decodedBytes = image.length; result.transportOpen = true;
    });
    if (process.env.QUALIFY_MODEL_LIST === '1') await scenario('model-list', async ({ adapter, signal, result }) => {
      const listed = await adapter.capabilities.models.api.list(signal);
      if (listed.kind !== 'ok') throw new ScenarioFailure('catalog-failed');
      result.models = listed.value.length;
    });
    else report.scenarios.push({ id: 'model-list', status: 'not-covered', reason: 'QUALIFY_MODEL_LIST=1 required' });
    if (process.env.QUALIFY_FILE_CHANGE === '1') await scenario('file-change', async ({ expectFile, adapter, cwd, request, activity, result, events, nativeDecisions }) => {
      const file = join(cwd, 'file.txt'); await writeFile(file, 'old\n');
      const expected = { path: file, present: true, contents: 'old\n' }; expectFile(expected);
      const pending = await adapter.run({ ...request, prompt: `Use the native patch/file-change tool to change old to new in ${file}, requesting user approval. If that tool is unavailable with the present shell-only configuration, explain that and do not use another tool.` });
      if (pending.kind === 'complete') {
        if (await readFile(file, 'utf8') !== 'old\n' || events.some(event => event.kind === 'native-item' && (event.item.data.params.item?.type === 'fileChange' || event.item.data.method === 'item/fileChange/patchUpdated'))) throw new ScenarioFailure('file-change-without-approval');
        result.status = 'not-covered'; result.reason = 'native-file-change-not-reachable'; return;
      }
      if (pending.kind !== 'pending' || !pending.approvals.some((a) => a.request.data.method === 'item/fileChange/requestApproval')) throw new ScenarioFailure('wrong-approval');
      const approval = pending.approvals.find((a) => a.request.data.method === 'item/fileChange/requestApproval');
      const item = await activity((e) => e.kind === 'native-item' && e.item.data.params.item?.type === 'fileChange'
        && e.item.data.params.item.id === approval.target.tool.nativeToolCallId);
      const validatePatch = () => {
        if (!scopedFileChange(pending, item?.item.data.params.item, file)) throw new ScenarioFailure('missing-file-activity');
        for (const event of events) {
          if (event.kind !== 'native-item') continue;
          const { method, params } = event.item.data;
          const candidate = method === 'item/fileChange/patchUpdated' && params.itemId === approval.target.tool.nativeToolCallId
            ? { type: 'fileChange', id: params.itemId, changes: params.changes } : params.item;
          if (candidate?.type === 'fileChange' && !scopedFileChange(pending, candidate, file)) throw new ScenarioFailure('unexpected-file-change');
        }
      };
      validatePatch();
      if (!approval.choices.some((c) => c.nativeChoiceId === 'accept')) throw new ScenarioFailure('missing-choice');
      const continued = await adapter.continue({ ...request, hostOperationId: `${request.hostOperationId}-answer`, recordIntent: validatePatch, answers: [{ formatVersion: 1, kind: 'approval', target: approval.target, nativeChoiceId: 'accept' }] });
      if (continued.kind !== 'complete') throw new ScenarioFailure('turn-not-complete');
      await activity(event => event.kind === 'native-item' && event.item.data.method === 'item/completed' && event.item.data.params.item?.id === approval.target.tool.nativeToolCallId);
      validatePatch();
      if (await readFile(file, 'utf8') !== 'new\n') throw new ScenarioFailure('marker-mismatch');
      expected.contents = 'new\n';
      if (!nativeDecisions.some(decision => Object.is(decision.requestId, approval.request.data.id) && decision.decision === 'accept')) throw new ScenarioFailure('file-decision-mismatch');
      result.correlatedChanges = item.item.data.params.item.changes.length;
    });
    else report.scenarios.push({ id: 'file-change', status: 'not-covered', reason: 'QUALIFY_FILE_CHANGE=1 required' });
  } catch (error) {
    report.precondition = ['dedicated-home-required', 'wrong-native-version', 'chatgpt-login-required', 'unsupported-platform', 'native-binary-missing'].includes(error.message) ? error.message : 'precondition-failed';
  } finally {
    try {
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    } finally {
      try { if (cleanupConfirmed) await rm(scratch, { recursive: true, force: true }); }
      finally { process.off('SIGINT', onStop); process.off('SIGTERM', onStop); }
    }
  }
  const passed = qualificationPassed(report);
  process.stdout.write(`${JSON.stringify({ passed, report: output, scenarios: report.scenarios, ...(report.precondition ? { precondition: report.precondition } : {}) })}\n`);
  if (!passed) process.exitCode = 1;
}
const frozenEntry = new URL(import.meta.url).searchParams.get('frozen') === '1';
const directEntry = process.argv[1] !== undefined
  && await realpath(process.argv[1]).catch(() => undefined) === await realpath(fileURLToPath(import.meta.url));
if (directEntry || frozenEntry) {
  if (process.env.SWITCHBOARD_QUALIFY_CODEX_HOST !== '1') process.stdout.write('Skipped: set SWITCHBOARD_QUALIFY_CODEX_HOST=1 with a dedicated ChatGPT CODEX_HOME.\n');
  else if (frozenEntry) await main();
  else {
    const snapshot = await snapshotQualificationSource(root);
    const entry = pathToFileURL(join(snapshot, 'scripts/qualify-codex-host-direct.mjs'));
    entry.searchParams.set('frozen', '1');
    entry.searchParams.set('report', resolve(process.env.SWITCHBOARD_CODEX_HOST_REPORT ?? join(root, '.audit/codex-host-direct.json')));
    try { await import(entry.href); }
    finally {
      if (!process.exitCode) await rm(snapshot, { recursive: true, force: true });
      else process.stdout.write(`${JSON.stringify({ retainedSource: snapshot })}\n`);
    }
  }
}

/** Copy compiler inputs and qualification modules before importing the code being qualified. */
export async function snapshotQualificationSource(sourceRoot) {
  const snapshot = await mkdtemp(join(tmpdir(), 'switchboard-codex-source-'));
  try {
    for (const path of ['src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json']) {
      await cp(join(sourceRoot, path), join(snapshot, path), { recursive: true });
    }
    async function rejectSymlinks(path) {
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new Error('unhashed-symlink');
      if (entry.isDirectory()) for (const name of await readdir(path)) await rejectSymlinks(join(path, name));
      else if (!entry.isFile()) throw new Error('unhashed-non-file');
    }
    for (const path of ['src', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json']) await rejectSymlinks(join(snapshot, path));
    await symlink(await realpath(join(sourceRoot, 'node_modules')), join(snapshot, 'node_modules'), 'dir');
    return snapshot;
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}
