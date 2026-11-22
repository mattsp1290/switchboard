// Explicit owner-run live gate. Reports contain only synthetic scenario labels and bounded statuses/counts.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { hostVariables } from './live-baseline-engines.mjs';
import { qualificationImage } from './support/qualification-image.mjs';
import { dedicatedHome, scopedCommand, scopedFileChange, stopChildren, closeAdapter, qualificationPassed, qualificationFingerprint, targetTerminals } from './support/codex-host-qualification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const delay = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const binary = join(root, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex');

async function launch(request, extra, children, nativeTerminals) {
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
      return new Promise((resolve, reject) => child.stdin.write(bytes, (error) => error ? reject(new Error('write failed')) : resolve()));
    },
  } };
}
async function main() {
  const stopped = new AbortController();
  const onStop = () => stopped.abort();
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  let cleanupConfirmed = true;
  const report = { date: new Date().toISOString(), nativeVersion: '0.169.0', binarySha256: null, login: 'not-covered', scenarios: [] };
  const output = resolve(process.env.SWITCHBOARD_CODEX_HOST_REPORT ?? join(root, '.audit/codex-host-direct.json'));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'switchboard-codex-direct-')));
  let home = process.env.CODEX_HOME;
  try {
    home = await dedicatedHome(home, join(homedir(), '.codex'));
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('unsupported-platform');
    if (!(await exists(binary))) throw new Error('native-binary-missing');
    report.fingerprint = await qualificationFingerprint(root);
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
    const { codexHostAdapter } = await import('../dist/adapters/codex/index.js');
    async function scenario(name, body) {
      if (stopped.signal.aborted) { report.scenarios.push({ id: name, status: 'not-covered', reason: 'qualification-stopped' }); return; }
      const cwd = join(scratch, name);
      const children = [];
      const nativeTerminals = [];
      let adapter;
      const events = [];
      const observations = [];
      const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(180000)]);
      const result = { id: name, status: 'failed' };
      try {
        await mkdir(cwd);
        const sqliteHome = join(scratch, `${name}-sqlite`); const logDir = join(scratch, `${name}-logs`);
        await mkdir(sqliteHome); await mkdir(logDir);
        const extra = ['-c', `sqlite_home=${JSON.stringify(sqliteHome)}`, '-c', `log_dir=${JSON.stringify(logDir)}`];
        const opened = await codexHostAdapter.open({ launch: { kind: 'spawn', spawn: (request) => launch(request, extra, children, nativeTerminals) },
          builtInTools: ['shell'], environment: { variables, nativeConfig: { home, cwd, executable: binary, sqliteHome, logDir,
            sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user', activity: 'items' } } }, signal);
        if (opened.kind !== 'ok') {
          result.openCode = opened.error.code;
          throw new Error('open-failed');
        }
        adapter = opened.value;
        adapter.events.subscribe((event) => { events.push(event); });
        const request = { signal, hostOperationId: name, recordIntent: () => {}, onObservation: (event) => { observations.push(event); } };
        await body({ adapter, cwd, events, observations, signal, request, result, nativeTerminals });
        result.nativeTerminals = nativeTerminals.map((terminal) => terminal.status);
        if (result.status === 'failed') result.status = 'passed';
      } catch (error) {
        result.nativeTerminals = nativeTerminals.map((terminal) => terminal.status);
        const allowed = new Set(['no-approval', 'wrong-approval', 'missing-choice', 'turn-not-complete', 'marker-mismatch',
          'missing-command-activity', 'missing-file-activity', 'interrupt-followup-failed', 'interrupt-unconfirmed', 'missing-withdrawal', 'pending-remains', 'image-failed', 'transport-not-open', 'catalog-failed', 'open-failed']);
        result.reason = allowed.has(error.message) ? error.message : 'scenario-failed';
      } finally {
        try {
          if ((await closeAdapter(adapter)) !== 'closed') { result.status = 'failed'; result.reason = 'close-failed'; }
        } catch { result.status = 'failed'; result.reason = 'close-failed'; }
        finally {
          if (!(await stopChildren(children))) { cleanupConfirmed = false; result.status = 'failed'; result.reason = 'cleanup-unconfirmed'; }
          report.scenarios.push(result);
        }
      }
    }
    const commandPrompt = (marker) => `Use the shell tool to run /usr/bin/touch ${marker}, with shell=/bin/sh and login=false so the command uses a non-login /bin/sh -c invocation. This is a disposable qualification marker. Request escalated permissions with sandbox_permissions=require_escalated and ask the user for approval. Do not use another tool, do not work around the read-only sandbox, and do not write anything before the approval is answered. After the decision, finish without another attempt.`;
    for (const choice of ['accept', 'cancel', 'interrupt']) await scenario(`command-${choice}`, async ({ adapter, cwd, events, observations, signal, request, result, nativeTerminals }) => {
      const marker = join(cwd, 'marker');
      const pending = await adapter.run({ ...request, prompt: commandPrompt(marker) });
      if (pending.kind !== 'pending' || pending.approvals.length !== 1) throw new Error('no-approval');
      const approval = pending.approvals[0];
      if (!scopedCommand(pending, cwd, marker)) throw new Error('wrong-approval');
      result.approvals = pending.approvals.length;
      if (choice === 'interrupt') {
        const interrupted = await adapter.interrupt({ timeoutMs: 10000 });
        if (!['interrupted', 'terminal-observed'].includes(interrupted.kind)) throw new Error('interrupt-unconfirmed');
        for (let i = 0; i < 100 && !events.some((e) => e.kind === 'interaction-settled' && e.settlement.data.kind === 'withdrawn'); i++) await delay(10);
        const settled = events.find((e) => e.kind === 'interaction-settled' && e.settlement.data.kind === 'withdrawn'
          && e.target.nativeApprovalId === approval.target.nativeApprovalId);
        if (!settled) throw new Error('missing-withdrawal');
        const current = await adapter.capabilities.inspect.api.pending(signal);
        if (current.kind !== 'ok' || current.value.approvals.length || current.value.calls.length) throw new Error('pending-remains');
        result.interrupt = interrupted.kind; result.localWithdrawal = settled.settlement.data.by === 'turn/interrupt';
        let terminal = interrupted;
        for (let i = 0; i < 1000 && terminal.kind !== 'terminal-observed' && !signal.aborted; i++) {
          await delay(100); terminal = await adapter.interrupt({ timeoutMs: 100 });
        }
        if (terminal.kind !== 'terminal-observed') throw new Error('interrupt-followup-failed');
        const followup = await adapter.run({ ...request, hostOperationId: `${request.hostOperationId}-followup`, prompt: 'Reply with OK. Do not use tools.' });
        if (followup.kind !== 'complete') throw new Error('interrupt-followup-failed');
        result.followupComplete = true;
      } else {
        if (!approval.choices.some((c) => c.nativeChoiceId === choice)) throw new Error('missing-choice');
        const continued = await adapter.continue({ ...request, hostOperationId: `${request.hostOperationId}-answer`,
          answers: [{ formatVersion: 1, kind: 'approval', target: approval.target, nativeChoiceId: choice }] });
        if (choice === 'cancel') {
          const declined = events.some((e) => e.kind === 'native-item' && e.item.data.method === 'item/completed'
            && e.item.data.params.item?.id === approval.target.tool.nativeToolCallId && e.item.data.params.item.status === 'declined');
          result.declinedItem = declined; result.segmentKind = continued.kind;
          result.segmentTerminal = observations.findLast((e) => e.kind === 'terminal')?.outcome;
          if (continued.kind === 'failed') result.writeKind = continued.write.kind;
          // Reply delivery certainty is separate from the native turn's terminal fact.
          const ended = targetTerminals(nativeTerminals, approval).some((status) => status === 'interrupted' || status === 'completed');
          result.nativeCancellationObserved = declined && ended;
          if (!declined || !ended || !['complete', 'failed'].includes(continued.kind)) throw new Error('turn-not-complete');
          if ((await adapter.interrupt({ timeoutMs: 100 })).kind !== 'terminal-observed') throw new Error('turn-not-complete');
        } else if (continued.kind !== 'complete') throw new Error('turn-not-complete');
        if (choice === 'accept' && !events.some((e) => e.kind === 'native-item' && e.item.data.method === 'item/completed'
          && e.item.data.params.item?.type === 'commandExecution' && e.item.data.params.item.id === approval.target.tool.nativeToolCallId && e.item.data.params.item.status === 'completed')) throw new Error('missing-command-activity');
      }
      if (await exists(marker) !== (choice === 'accept')) throw new Error('marker-mismatch');
      result.markerPresent = choice === 'accept';
    });
    await scenario('image-4mib', async ({ adapter, request, result }) => {
      const image = qualificationImage();
      if ((await adapter.run({ ...request, prompt: 'Briefly describe this image.', images: [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${image.toString('base64')}` }] })).kind !== 'complete') throw new Error('image-failed');
      if ((await adapter.run({ ...request, hostOperationId: 'image-followup', prompt: 'Reply with OK.' })).kind !== 'complete') throw new Error('transport-not-open');
      result.decodedBytes = image.length; result.transportOpen = true;
    });
    if (process.env.QUALIFY_MODEL_LIST === '1') await scenario('model-list', async ({ adapter, signal, result }) => {
      const listed = await adapter.capabilities.models.api.list(signal);
      if (listed.kind !== 'ok') throw new Error('catalog-failed');
      result.models = listed.value.length;
    });
    else report.scenarios.push({ id: 'model-list', status: 'not-covered', reason: 'QUALIFY_MODEL_LIST=1 required' });
    if (process.env.QUALIFY_FILE_CHANGE === '1') await scenario('file-change', async ({ adapter, cwd, request, events, result }) => {
      const file = join(cwd, 'file.txt'); await writeFile(file, 'old\n');
      const pending = await adapter.run({ ...request, prompt: `Use the native patch/file-change tool to change old to new in ${file}, requesting user approval. If that tool is unavailable with the present shell-only configuration, explain that and do not use another tool.` });
      if (pending.kind === 'complete') { result.status = 'not-covered'; result.reason = 'native-file-change-not-reachable'; return; }
      if (pending.kind !== 'pending' || !pending.approvals.some((a) => a.request.data.method === 'item/fileChange/requestApproval')) throw new Error('wrong-approval');
      const approval = pending.approvals.find((a) => a.request.data.method === 'item/fileChange/requestApproval');
      const item = events.find((e) => e.kind === 'native-item' && e.item.data.params.item?.type === 'fileChange'
        && e.item.data.params.item.id === approval.target.tool.nativeToolCallId);
      if (!scopedFileChange(pending, item?.item.data.params.item, file)) throw new Error('missing-file-activity');
      if (!approval.choices.some((c) => c.nativeChoiceId === 'accept')) throw new Error('missing-choice');
      const continued = await adapter.continue({ ...request, hostOperationId: `${request.hostOperationId}-answer`, answers: [{ formatVersion: 1, kind: 'approval', target: approval.target, nativeChoiceId: 'accept' }] });
      if (continued.kind !== 'complete') throw new Error('turn-not-complete');
      if (await readFile(file, 'utf8') !== 'new\n') throw new Error('marker-mismatch');
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
if (process.env.SWITCHBOARD_QUALIFY_CODEX_HOST !== '1') process.stdout.write('Skipped: set SWITCHBOARD_QUALIFY_CODEX_HOST=1 with a dedicated ChatGPT CODEX_HOME.\n');
else await main();
