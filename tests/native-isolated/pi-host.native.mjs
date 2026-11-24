import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { piHostAdapter, validatePiHostSessionState } from '@operatorworks/switchboard/host/pi';

const base = {
  launch: { kind: 'in-process' },
  environment: { variables: { PATH: '/usr/bin', TMPDIR: tmpdir() }, nativeConfig: {} },
  instructions: 'Answer briefly.',
  subagents: 'off',
};
const openSignal = () => new AbortController().signal;
const run = (prompt, recordIntent = async () => {}) => ({
  hostOperationId: `op-${prompt}`, prompt, recordIntent, signal: openSignal(),
});

async function open(extra) {
  const requests = [];
  const states = [];
  const events = [];
  const opened = await piHostAdapter.open({
    ...base, ...extra, onState: (state) => { states.push(state); return extra.onState?.(state); },
    stream: extra.stream ?? (async function* stream(request) {
      requests.push(request);
      yield { kind: 'text', text: 'hello' };
      yield { kind: 'usage', input: 2, output: 1 };
    }),
  }, openSignal());
  assert.equal(opened.kind, 'ok', opened.kind === 'error' ? opened.error.message : '');
  const subscription = opened.value.events.subscribe((event) => { events.push(event); });
  assert.equal(subscription.kind, 'ok');
  return { adapter: opened.value, requests, states, events, close: () => opened.value.close() };
}

test('a host stream answers with no route and exports state', async () => {
  let intents = 0;
  const host = await open({});
  const result = await host.adapter.run(run('Say hello', async () => { intents += 1; }));
  assert.equal(result.kind, 'complete');
  assert.equal(result.text, 'hello');
  assert.equal(result.usage.native.data.input, 2);
  assert.equal(result.usage.native.data.output, 1);
  assert.equal(Object.hasOwn(result.usage.native.data, 'total'), false);
  assert.equal(intents, 1);
  assert.equal(host.requests.length, 1);
  assert.equal(host.requests[0].instructions, 'Answer briefly.');
  assert.equal(validatePiHostSessionState(host.states.at(-1)), true);
  assert.equal(host.states.at(-1).turns.some((turn) => turn.role === 'assistant' && turn.text === 'hello'), true);
  const refused = await piHostAdapter.open({ ...base, stream: host.adapter.state && (async function* () {}), route: {
    config: { kind: 'direct', model: 'glm-5.3', resolve: () => 'key' },
    scope: { engine: 'pi', account: 'a', adapterInstanceId: 'i', sessionId: 's' },
  } }, openSignal());
  assert.equal(refused.kind, 'error');
  await host.close();
});

test('a thrown host stream is not a completed export', async () => {
  const host = await open({ stream: async function* stream() {
    yield { kind: 'usage', input: 0, output: 0 };
    throw new Error('boom');
  } });
  const result = await host.adapter.run(run('Fail'));
  assert.equal(result.kind, 'failed');
  assert.equal(result.error.code, 'native-failure');
  assert.equal(host.states.length, 0);
  await host.close();
});

test('an aborted signal does not record intent', async () => {
  const host = await open({});
  const signal = AbortSignal.abort();
  let intents = 0;
  const result = await host.adapter.run({ hostOperationId: 'op-abort', prompt: 'Stop', recordIntent: async () => { intents += 1; }, signal });
  assert.equal(result.kind, 'failed');
  assert.equal(result.write.kind, 'not-dispatched');
  assert.equal(result.write.reason, 'aborted');
  assert.equal(intents, 0);
  assert.equal(host.states.length, 0);
  await host.close();
});

test('a host tool pauses and a fresh adapter continues it once', async () => {
  const tools = [{ name: 'lookup', description: 'Looks up a value.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
  const first = await open({
    tools,
    stream: async function* stream() {
      yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: { q: 'tide' } };
      yield { kind: 'usage', input: 4, output: 2 };
    },
  });
  const paused = await first.adapter.run(run('Look up tide'));
  assert.equal(paused.kind, 'pending', paused.kind === 'failed' ? paused.error.message : paused.kind);
  assert.equal(paused.calls.length, 1);
  assert.equal(paused.calls[0].name, 'lookup');
  assert.deepEqual(paused.calls[0].arguments, { q: 'tide' });
  assert.equal(first.events.some((event) => event.kind === 'tool-call-start'), true);
  assert.equal(first.events.findIndex((event) => event.kind === 'tool-call-start')
    < first.events.findIndex((event) => event.kind === 'tool-call-end'), true);
  const imported = first.adapter.state();
  await first.close();
  const requests = [];
  const second = await open({
    tools, state: imported,
    stream: async function* stream(request) {
      requests.push(request);
      yield { kind: 'text', text: 'the tide is high' };
      yield { kind: 'usage', input: 5, output: 3 };
    },
  });
  const pending = await second.adapter.capabilities.inspect.api.pending(openSignal());
  assert.equal(pending.kind, 'ok');
  const call = pending.value.calls[0];
  const continued = await second.adapter.continue({
    hostOperationId: 'op-continue',
    signal: openSignal(),
    recordIntent: async () => {},
    answers: [{ formatVersion: 1, kind: 'tool', outcome: {
      target: call.pending.target,
      result: { kind: 'ok', value: { namespace: 'crew', schemaVersion: 1, data: { text: 'high' } } },
      effect: { kind: 'known', effect: 'none', evidence: { namespace: 'crew', schemaVersion: 1, data: {} } },
      delivery: { kind: 'unknown' },
    } }],
  });
  assert.equal(continued.kind, 'complete', continued.kind === 'failed' ? `${continued.error.message} ${continued.write.kind}` : continued.kind);
  assert.equal(continued.text, 'the tide is high');
  assert.equal(requests.length, 1);
  const toolTurns = requests[0].turns.filter((turn) => turn.role === 'tool' && turn.toolCallId === 'call-1');
  assert.equal(toolTurns.length, 1);
  assert.match(toolTurns[0].text, /high/);
  const again = await second.adapter.continue({
    hostOperationId: 'op-again', signal: openSignal(), recordIntent: async () => {},
    answers: [{ formatVersion: 1, kind: 'tool', outcome: {
      target: call.pending.target,
      result: { kind: 'ok', value: { namespace: 'crew', schemaVersion: 1, data: { text: 'again' } } },
      effect: { kind: 'unknown' }, delivery: { kind: 'unknown' },
    } }],
  });
  assert.equal(again.kind, 'failed');
  assert.equal(again.write.kind, 'not-attempted');
  const completedState = second.adapter.state();
  await second.close();
  const third = await open({ tools, state: completedState });
  assert.equal((await third.adapter.capabilities.inspect.api.pending(openSignal())).value.calls.length, 0);
  await third.close();
});

test('a mixed tool batch fails before a host tool runs', async () => {
  const host = await open({
    tools: [{ name: 'lookup', description: 'Looks up a value.', inputSchema: { type: 'object' } }],
    stream: async function* stream() {
      yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: {} };
      yield { kind: 'tool-call', id: 'call-2', name: 'bash', arguments: { command: 'pwd' } };
    },
  });
  const result = await host.adapter.run(run('Do both'));
  assert.equal(result.kind, 'failed');
  assert.equal(result.error.code, 'invalid-input');
  assert.equal(result.write.kind, 'accepted');
  assert.equal(host.events.some((event) => event.kind === 'tool-call-start'), false);
  assert.equal(host.states.length, 0);
  await host.close();
});

test('a provider request that reported no usage still emits a model boundary, without usage', async () => {
  const host = await open({ stream: async function* stream() { yield { kind: 'text', text: 'hi' }; } });
  const seen = [];
  const result = await host.adapter.run({ ...run('Say hi'), onObservation: (o) => { seen.push(o); } });
  assert.equal(result.kind, 'complete');
  assert.deepEqual(seen.filter((o) => o.kind === 'model-boundary'), [{ kind: 'model-boundary' }]);
  assert.equal(seen.some((o) => o.kind === 'usage'), false);
  await host.close();
});

test('invalid token counts keep the model boundary but drop usage', async () => {
  const host = await open({ stream: async function* stream() { yield { kind: 'text', text: 'hi' }; yield { kind: 'usage', input: 1.5, output: 2 }; } });
  const seen = [];
  const result = await host.adapter.run({ ...run('Say hi'), onObservation: (o) => { seen.push(o); } });
  assert.equal(result.kind, 'complete');
  assert.ok(seen.filter((o) => o.kind === 'model-boundary').every((o) => !('usage' in o) || o.usage.inputTokens === undefined));
  assert.equal(seen.some((o) => o.kind === 'usage' && o.rows.some((r) => r.inputTokens === 1.5)), false);
  assert.equal(seen.some((o) => o.kind === 'invalid-observation'), false);
  await host.close();
});

test('a segment listener receives model boundaries, tool facts, usage and a terminal', async () => {
  const tools = [{ name: 'lookup', description: 'Looks up a value.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }];
  const first = await open({ tools, stream: async function* stream() {
    yield { kind: 'text', text: 'checking' };
    yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: { q: 'tide' } };
    yield { kind: 'usage', input: 4, output: 2 };
  } });
  const seen = [];
  const paused = await first.adapter.run({ ...run('Look up tide'), onObservation: (o) => { seen.push(o); } });
  assert.equal(paused.kind, 'pending');
  assert.equal(seen[0].kind, 'run-started');
  assert.deepEqual(seen.filter((o) => o.kind === 'unsupported').map((o) => o.family),
    ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'subagents', 'reasoning']);
  assert.deepEqual(seen.find((o) => o.kind === 'text'), { kind: 'text', messageId: 'assistant', mode: 'delta', text: 'checking' });
  assert.deepEqual(seen.filter((o) => o.kind === 'tool'), [
    { kind: 'tool', callId: 'call-1', name: 'lookup', phase: 'started' },
    { kind: 'tool', callId: 'call-1', name: 'lookup', phase: 'arguments-ended', argumentsJson: '{"q":"tide"}' }]);
  assert.deepEqual(seen.filter((o) => o.kind === 'model-boundary'), [
    { kind: 'model-boundary', usage: { inputTokens: 4, outputTokens: 2 } }]);
  assert.deepEqual(seen.find((o) => o.kind === 'usage'), { kind: 'usage', rows: [{ inputTokens: 4, outputTokens: 2 }] });
  assert.deepEqual(seen.at(-1), { kind: 'terminal', outcome: 'success', pendingTools: ['call-1'] });
  assert.equal(seen.filter((o) => o.kind === 'terminal').length, 1);
  const imported = first.adapter.state();
  await first.close();

  const second = await open({ tools, state: imported, stream: async function* stream() {
    yield { kind: 'text', text: 'the tide is high' };
    yield { kind: 'usage', input: 5, output: 3 };
  } });
  const pending = await second.adapter.capabilities.inspect.api.pending(openSignal());
  const call = pending.value.calls[0];
  const next = [];
  const done = await second.adapter.continue({ hostOperationId: 'op-observed', signal: openSignal(), recordIntent: async () => {},
    onObservation: (o) => { next.push(o); },
    answers: [{ formatVersion: 1, kind: 'tool', outcome: { target: call.pending.target,
      result: { kind: 'ok', value: { namespace: 'crew', schemaVersion: 1, data: { text: 'high' } } },
      effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } }] });
  assert.equal(done.kind, 'complete');
  assert.equal(next[0].kind, 'run-started');
  assert.deepEqual(next.filter((o) => o.kind === 'tool'), [
    { kind: 'tool', callId: 'call-1', name: 'lookup', phase: 'started' },
    { kind: 'tool', callId: 'call-1', name: 'lookup', phase: 'arguments-ended', argumentsJson: '{"q":"tide"}' },
    { kind: 'tool', callId: 'call-1', name: 'lookup', phase: 'completed', resultJson: '{"text":"high"}' }]);
  assert.deepEqual(next.at(-1), { kind: 'terminal', outcome: 'success' });
  await second.close();
});

test('a throwing listener does not change a segment and an invalid one is refused', async () => {
  const host = await open({});
  const result = await host.adapter.run({ ...run('Say hello'), onObservation: () => { throw new Error('boom'); } });
  assert.equal(result.kind, 'complete');
  assert.equal(result.text, 'hello');
  let intents = 0;
  const refused = await host.adapter.run({ ...run('Again', async () => { intents += 1; }), onObservation: 'nope' });
  assert.equal(refused.kind, 'failed');
  assert.equal(refused.error.code, 'invalid-input');
  assert.equal(refused.write.kind, 'not-attempted');
  assert.equal(intents, 0);
  await host.close();
});

test('Pi-host rejects unsupported media before intent, stream dispatch or history changes', async () => {
  const subject = await open({});
  try {
    assert.equal(subject.adapter.capabilities.imageInput.kind, 'unsupported');
    assert.equal((await subject.adapter.run(run('baseline'))).kind, 'complete');
    const before = subject.adapter.state();
    const writes = subject.requests.length;
    for (const images of [[{ mediaType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }], null, {}]) {
      const result = await subject.adapter.run({ ...run('image', () => assert.fail('unsupported media must not record intent')), images });
      assert.equal(result.error.code, 'unsupported');
      assert.equal(result.write.kind, 'not-attempted');
    }
    assert.equal(subject.requests.length, writes);
    assert.deepEqual(subject.adapter.state(), before);
  } finally { await subject.close(); }
});

test('Pi-host captures prompt once before validation and intent', async () => {
  const host = await open({}); let reads = 0;
  try {
    const result = await host.adapter.run({ ...run('captured'), get prompt() { return ++reads <= 3 ? 'captured' : 'x'.repeat(4194305); } });
    assert.equal(result.kind, 'complete'); assert.equal(reads, 1);
    assert(host.requests[0].turns.some((turn) => turn.role === 'user' && turn.text === 'captured'));
  } finally { await host.close(); }
});

test('Pi-host returns a typed pre-dispatch refusal for non-JSON tool results', async () => {
  let calls = 0;
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    stream: async function* () { calls++; yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: {} }; } });
  try {
    const pending = await host.adapter.run(run('tool')); assert.equal(pending.kind, 'pending');
    const cycle = []; cycle.push(cycle);
    for (const data of [cycle, 1n, undefined, () => 1, Symbol('not JSON'), 'x'.repeat(100000)]) {
      let intents = 0;
      const result = await host.adapter.continue({ hostOperationId: 'invalid-result', signal: openSignal(), recordIntent() { intents++; },
        answers: [{ formatVersion: 1, kind: 'tool', outcome: { target: pending.calls[0].pending.target,
          result: { kind: 'ok', value: { namespace: 'fixture', schemaVersion: 1, data } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } }] });
      assert.equal(result.error.code, 'invalid-input'); assert.equal(result.write.kind, 'not-attempted'); assert.equal(intents, 0);
      assert.equal(calls, 1); assert.equal((await host.adapter.capabilities.inspect.api.pending(openSignal())).value.calls.length, 1);
    }
  } finally { await host.close(); }
});

test('Pi-host provider and observer receive one captured serialization of a tool answer',async()=>{
 let calls=0;let provider;const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(request){
  if(++calls===1)yield{kind:'tool-call',id:'call-1',name:'lookup',arguments:{}};else{provider=request;yield{kind:'text',text:'done'};}
 }});
 try{
  const pending=await host.adapter.run(run('tool'));let serializations=0;const data={toJSON(){return{version:++serializations};}};const seen=[];
  const result=await host.adapter.continue({hostOperationId:'captured-answer',signal:openSignal(),recordIntent(){},onObservation(e){seen.push(e);},answers:[{formatVersion:1,kind:'tool',outcome:{target:pending.calls[0].pending.target,result:{kind:'ok',value:{namespace:'fixture',schemaVersion:1,data}},effect:{kind:'unknown'},delivery:{kind:'unknown'}}}]});
  assert.equal(result.kind,'complete');assert.equal(serializations,1);assert.equal(provider.turns.find(t=>t.role==='tool').text,seen.find(e=>e.kind==='tool'&&e.phase==='completed').resultJson);
 }finally{await host.close();}
});

test('Pi-host interrupt validates bounds before abort and clears a completed long deadline',async(t)=>{
 const started=Promise.withResolvers();let signal;const host=await open({stream:async function*(request){signal=request.signal;started.resolve();await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));yield{kind:'text',text:''};}});
 const running=host.adapter.run(run('wait'));await started.promise;const armed=new Set();const schedule=globalThis.setTimeout;const cancel=globalThis.clearTimeout;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{const timer=schedule(fn,ms,...args);if(ms===2147483647)armed.add(timer);return timer;});
 t.mock.method(globalThis,'clearTimeout',timer=>{armed.delete(timer);return cancel(timer);});
 try{
  for(const timeoutMs of [0,1.5,2147483648]){assert.equal((await host.adapter.interrupt({timeoutMs})).kind,'unconfirmed-within-bound');assert.equal(signal.aborted,false);}
  assert.equal((await host.adapter.interrupt({timeoutMs:2147483647})).kind,'terminal-observed');assert.equal(armed.size,0);await running;
 }finally{for(const timer of armed)cancel(timer);await host.close();}
});

test('malformed Pi-host signals refuse before claiming the segment',async()=>{
 const host=await open({});try{
  const result=await host.adapter.run({...run('bad-signal'),signal:{},recordIntent(){assert.fail('invalid signal must not record');}});
  assert.equal(result.error.code,'invalid-input');assert.equal(result.write.kind,'not-attempted');assert.equal((await host.adapter.run(run('valid-after-refusal'))).kind,'complete');
 }finally{await host.close();}
});

test('a throwing Pi-host store callback cannot reoffer an answered target',async()=>{
 let exports=0;let requests=0;const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],onState(){if(++exports===2)throw new Error('store failed');},stream:async function*(){if(++requests===1)yield{kind:'tool-call',id:'call-1',name:'lookup',arguments:{}};else yield{kind:'text',text:'done'};}});
 try{
  const pending=await host.adapter.run(run('tool'));const answer={formatVersion:1,kind:'tool',outcome:{target:pending.calls[0].pending.target,result:{kind:'ok',value:{namespace:'fixture',schemaVersion:1,data:{value:'saved'}}},effect:{kind:'unknown'},delivery:{kind:'unknown'}}};
  const result=await host.adapter.continue({hostOperationId:'store-failure',signal:openSignal(),recordIntent(){},answers:[answer]});assert.equal(result.kind,'failed');
  assert.equal(host.adapter.state().turns.find(t=>t.role==='tool').pending,false);assert.equal((await host.adapter.capabilities.inspect.api.pending(openSignal())).value.calls.length,0);
  const duplicate=await host.adapter.continue({hostOperationId:'duplicate-after-store-failure',signal:openSignal(),recordIntent(){assert.fail('an answered target cannot record another intent');},answers:[answer]});assert.equal(duplicate.write.kind,'not-attempted');assert.equal(requests,2);
 }finally{await host.close();}
});

test('a continuation cannot reissue the tool call ID whose result it is consuming', async () => {
  let requests = 0;
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    stream: async function* () {
      if (++requests <= 2) yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: {} };
      else yield { kind: 'text', text: 'recovered' };
    } });
  try {
    const paused = await host.adapter.run(run('tool'));
    const answer = { formatVersion: 1, kind: 'tool', outcome: { target: paused.calls[0].pending.target,
      result: { kind: 'ok', value: { namespace: 'fixture', schemaVersion: 1, data: 'answer' } },
      effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
    const published = host.events.filter(e => e.kind === 'tool-call-start').length;
    const duplicate = await host.adapter.continue({ hostOperationId: 'reused-call', signal: openSignal(), recordIntent() {}, answers: [answer] });
    assert.equal(duplicate.kind, 'failed', JSON.stringify(duplicate));
    assert.equal(duplicate.error.code, 'invalid-input');
    assert.equal(host.events.filter(e => e.kind === 'tool-call-start').length, published);
    const state = host.adapter.state();
    assert.equal(state.turns.find(turn => turn.role === 'tool').pending, true);
    await host.close();
    const fresh = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], state,
      stream: async function* () { yield { kind: 'text', text: 'recovered' }; } });
    try {
      const pending = await fresh.adapter.capabilities.inspect.api.pending(openSignal());
      assert.equal(pending.value.calls[0].pending.target.nativeToolCallId, 'call-1');
      const recovered = await fresh.adapter.continue({ hostOperationId: 'recover-call', signal: openSignal(), recordIntent() {}, answers: [answer] });
      assert.equal(recovered.kind, 'complete', JSON.stringify(recovered));
      assert.equal(recovered.text, 'recovered');
    } finally { await fresh.close(); }
  } finally { await host.close(); }
});

test('an uncertain continuation requires reopening from the last exported state', async t => {
  const { AgentSession } = await import('@earendil-works/pi-coding-agent');
  const original = AgentSession.prototype.waitForIdle;
  let fail = false;
  t.mock.method(AgentSession.prototype, 'waitForIdle', async function (...args) {
    if (fail) { fail = false; throw new Error('failed idle observation'); }
    return original.apply(this, args);
  });
  const requests = [];
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    stream: async function* (request) {
      requests.push(request);
      if (requests.length === 1) yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: {} };
      else yield { kind: 'text', text: 'unexported uncertain response' };
    } });
  try {
    const paused = await host.adapter.run(run('tool'));
    const answer = { formatVersion: 1, kind: 'tool', outcome: { target: paused.calls[0].pending.target,
      result: { kind: 'ok', value: { namespace: 'fixture', schemaVersion: 1, data: 'staged answer' } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
    fail = true;
    assert.equal((await host.adapter.continue({ hostOperationId: 'failed-idle', signal: openSignal(), recordIntent() {}, answers: [answer] })).kind, 'failed');
    const state = host.adapter.state();
    assert.equal(state.turns.find(turn => turn.role === 'tool').pending, true);
    assert.equal(JSON.stringify(state).includes('unexported uncertain response'), false);
    for (const operation of ['run', 'continue']) {
      const input = { ...run('refused'), answers: [answer], recordIntent() { assert.fail('uncertain session cannot record another intent'); } };
      assert.equal((await host.adapter[operation](input)).write.kind, 'not-attempted');
    }
    assert.equal(requests.length, 2);
    assert.equal(host.states.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.events.some(e => e.kind === 'tool-delivery'), false);
    await host.close();
    const fresh = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], state,
      stream: async function* (request) {
        assert.equal(JSON.stringify(request).includes('unexported uncertain response'), false);
        yield { kind: 'text', text: 'recovered' };
      } });
    try {
      const recovered = await fresh.adapter.continue({ hostOperationId: 'fresh-recovery', signal: openSignal(), recordIntent() {}, answers: [answer] });
      assert.equal(recovered.kind, 'complete');
      assert.equal(recovered.text, 'recovered');
      assert.equal(JSON.stringify(fresh.adapter.state()).includes('unexported uncertain response'), false);
    } finally { await fresh.close(); }
  } finally { await host.close(); }
});

test('a staging enumeration failure requires a fresh adapter without exporting partial changes', async t => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const original = SessionManager.prototype.getEntries;
  let fail = false;
  t.mock.method(SessionManager.prototype, 'getEntries', function (...args) {
    if (fail) { fail = false; throw new Error('staging read failed'); }
    return original.apply(this, args);
  });
  let requests = 0;
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    stream: async function* () { requests++; yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: {} }; } });
  try {
    const paused = await host.adapter.run(run('tool'));
    const answer = { formatVersion: 1, kind: 'tool', outcome: { target: paused.calls[0].pending.target,
      result: { kind: 'ok', value: { namespace: 'fixture', schemaVersion: 1, data: 'answer' } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
    fail = true;
    assert.equal((await host.adapter.continue({ hostOperationId: 'failed-enumeration', signal: openSignal(), recordIntent() {}, answers: [answer] })).kind, 'failed');
    assert.equal(host.adapter.state().turns.find(turn => turn.role === 'tool').pending, true);
    const next = await host.adapter.run(run('refused', () => assert.fail('cannot record after uncertain staging')));
    assert.equal(next.write.kind, 'not-attempted');
    assert.equal(requests, 1);
    assert.equal(host.states.length, 1);
  } finally { await host.close(); }
});

test('a failed write to a frozen staging record still settles and restores earlier writes', async t => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const original = SessionManager.prototype.getEntries;
  let freeze = false;
  let writable;
  t.mock.method(SessionManager.prototype, 'getEntries', function (...args) {
    const entries = original.apply(this, args);
    if (!freeze) return entries;
    freeze = false;
    return entries.map(entry => {
      if (entry.type !== 'message' || entry.message.role !== 'toolResult') return entry;
      writable = entry.message;
      return { ...entry, message: Object.freeze({ ...entry.message }) };
    });
  });
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
    stream: async function* () { yield { kind: 'tool-call', id: 'call-1', name: 'lookup', arguments: {} }; } });
  try {
    const paused = await host.adapter.run(run('tool'));
    const answer = { formatVersion: 1, kind: 'tool', outcome: { target: paused.calls[0].pending.target,
      result: { kind: 'ok', value: { namespace: 'fixture', schemaVersion: 1, data: 'answer' } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
    freeze = true;
    const result = await host.adapter.continue({ hostOperationId: 'frozen-staging', signal: openSignal(), recordIntent() {}, answers: [answer] });
    assert.equal(result.kind, 'failed');
    assert.equal(host.adapter.state().turns.find(turn => turn.role === 'tool').pending, true);
    assert.equal(writable.details.pending, true);
    assert.equal((await host.adapter.interrupt({ timeoutMs: 100 })).kind, 'terminal-observed');
    assert.equal((await host.adapter.run(run('refused', () => assert.fail('cannot record after failed staging')))).write.kind, 'not-attempted');
  } finally { await host.close(); }
});

test('close while intent is pending prevents dispatch on the disposed Pi session',async()=>{
 const host=await open({}),intent=Promise.withResolvers(),entered=Promise.withResolvers();let observations=[];
 const running=host.adapter.run({...run('held',()=>{entered.resolve();return intent.promise;}),onObservation:o=>observations.push(o)});await entered.promise;
 await host.close();intent.resolve();const result=await running;
 assert.equal(result.write.kind,'not-dispatched');assert.equal(host.requests.length,0);assert.equal(observations.some(o=>o.kind==='run-started'),false);
});
test('a fresh Pi prompt cannot bypass unanswered host calls',async()=>{
 let requests=0;const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){requests++;yield{kind:'tool-call',id:'held-call',name:'lookup',arguments:{}};}});
 try{const first=await host.adapter.run(run('tool'));assert.equal(first.kind,'pending');let intents=0;const second=await host.adapter.run(run('bypass',()=>{intents++;}));assert.equal(second.error?.code,'busy');assert.equal(second.write.kind,'not-attempted');assert.equal(intents,0);assert.equal(requests,1);assert.equal((await host.adapter.capabilities.inspect.api.pending(openSignal())).value.calls.length,1);}finally{await host.close();}
});
test('Pi state callback failure preserves native acceptance evidence',async()=>{
 const host=await open({onState(){throw new Error('store unavailable');}});
 try{const result=await host.adapter.run(run('export'));assert.equal(result.kind,'failed');assert.equal(result.write.kind,'accepted');assert.equal(host.adapter.state().turns.at(-1).text,'hello');}finally{await host.close();}
});
test('Pi pending export reserves room for at least one continuation response',async()=>{
 const host=await open({state:{formatVersion:1,sessionId:'capacity-session',turns:Array.from({length:124},()=>({segment:1,role:'user',text:'prior'}))},tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){yield{kind:'tool-call',id:'last-call',name:'lookup',arguments:{}};}});
 try{const result=await host.adapter.run(run('last'));assert.equal(result.kind,'failed');assert.equal(result.write.kind,'accepted');assert.equal(host.states.length,0);assert.equal((await host.adapter.capabilities.inspect.api.pending(openSignal())).value.calls.length,0);}finally{await host.close();}
});

test('an aborted Pi route requires reopening before another provider request',async t=>{
 const entered=Promise.withResolvers();let requests=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{if(++requests===1){entered.resolve();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw new Error('aborted');}return Response.json({events:[{kind:'text',text:'recovered'}]});});
 const routeOptions={...base,route:{config:{kind:'host-route',model:'fixture/model',endpoint:'http://127.0.0.1:9',protocol:'switchboard-host',credentialPurpose:'host-route',credentialForm:'none',principal:'crew-relay',resolve:()=>({purpose:'host-route',form:'none'})},scope:{engine:'pi',account:'fixture',adapterInstanceId:'fixture',sessionId:'route-session'}}};
 const opened=await piHostAdapter.open(routeOptions,openSignal());assert.equal(opened.kind,'ok');const adapter=opened.value;
 try{const control=new AbortController(),running=adapter.run({...run('first'),signal:control.signal});await entered.promise;control.abort();assert.equal((await running).write.kind,'outcome-unknown');assert.equal((await adapter.run(run('second'))).write.kind,'not-attempted');assert.equal(requests,1);const state=adapter.state();await adapter.close();const reopened=await piHostAdapter.open({...routeOptions,state},openSignal());assert.equal(reopened.kind,'ok');try{const result=await reopened.value.run(run('recovered'));assert.equal(result.kind,'complete');assert.equal(result.text,'recovered');}finally{await reopened.value.close();}}finally{await adapter.close();}
});
test('an imported Pi history at the limit refuses before intent and provider dispatch',async()=>{
 const state={formatVersion:1,sessionId:'full-session',turns:[...Array.from({length:126},()=>({segment:1,role:'user',text:'prior'})),{segment:1,role:'assistant',text:'',toolCalls:[{id:'pending-last',name:'lookup',arguments:{}}]},{segment:1,role:'tool',toolCallId:'pending-last',name:'lookup',text:'',pending:true}]};const host=await open({state,tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}]});
 try{const pending=await host.adapter.capabilities.inspect.api.pending(openSignal());let intents=0;const result=await host.adapter.continue({hostOperationId:'full-history',signal:openSignal(),recordIntent(){intents++;},answers:[{formatVersion:1,kind:'tool',outcome:{target:pending.value.calls[0].pending.target,result:{kind:'ok',value:{namespace:'fixture',schemaVersion:1,data:{text:'answer'}}},effect:{kind:'unknown'},delivery:{kind:'unknown'}}}]});assert.equal(result.write.kind,'not-attempted');assert.equal(intents,0);assert.equal(host.requests.length,0);}finally{await host.close();}
});
test('Pi run-started abort prevents the provider request',async()=>{
 const host=await open({}),control=new AbortController();try{const result=await host.adapter.run({...run('abort-at-start'),signal:control.signal,onObservation(o){if(o.kind==='run-started')control.abort();}});assert.equal(result.kind,'failed');assert.equal(host.requests.length,0);}finally{await host.close();}
});
test('Pi answered-tool observation abort prevents native continuation',async()=>{
 let requests=0;const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){if(++requests===1)yield{kind:'tool-call',id:'abort-answer',name:'lookup',arguments:{}};else yield{kind:'text',text:'must not request'};}});
 try{const pending=await host.adapter.run(run('tool'));const control=new AbortController();const result=await host.adapter.continue({hostOperationId:'abort-answer',signal:control.signal,recordIntent(){},onObservation(o){if(o.kind==='tool'&&o.phase==='completed')control.abort();},answers:[{formatVersion:1,kind:'tool',outcome:{target:pending.calls[0].pending.target,result:{kind:'ok',value:{namespace:'fixture',schemaVersion:1,data:{text:'answer'}}},effect:{kind:'unknown'},delivery:{kind:'unknown'}}}]});assert.equal(result.kind,'failed');assert.deepEqual(result.write,{kind:'not-dispatched',reason:'aborted'});assert.equal(host.adapter.state().turns.find(turn=>turn.role==='tool').pending,true);assert.equal(requests,1);}finally{await host.close();}
});
test('unexportable Pi history blocks subsequent provider requests',async()=>{
 let requests=0;const host=await open({stream:async function*(){yield{kind:'text',text:++requests===1?'x'.repeat(100001):'short'};}});
 try{assert.equal((await host.adapter.run(run('oversize'))).kind,'failed');let intents=0;const next=await host.adapter.run(run('next',()=>{intents++;}));assert.equal(next.write.kind,'not-attempted');assert.equal(intents,0);assert.equal(requests,1);}finally{await host.close();}
});
test('ambiguous imported Pi call identities are refused',async()=>{
 const pair=[{segment:1,role:'assistant',text:'',toolCalls:[{id:'duplicate',name:'lookup',arguments:{}}]},{segment:1,role:'tool',toolCallId:'duplicate',name:'lookup',text:'',pending:true}];
 const opened=await piHostAdapter.open({...base,state:{formatVersion:1,sessionId:'duplicate-session',turns:[...pair,...pair]},tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){}},openSignal());if(opened.kind==='ok')await opened.value.close();assert.equal(opened.kind,'error');assert.equal(opened.error.code,'invalid-input');
});
test('Pi error answers retain their marker in immediate and reopened provider history',async()=>{
 let requests=0;const bodies=[];const tools=[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}];const host=await open({tools,stream:async function*(body){bodies.push(body);if(++requests===1)yield{kind:'tool-call',id:'error-answer',name:'lookup',arguments:{}};else yield{kind:'text',text:'done'};}});let state;
 try{const pending=await host.adapter.run(run('tool'));const result=await host.adapter.continue({hostOperationId:'error-answer',signal:openSignal(),recordIntent(){},answers:[{formatVersion:1,kind:'tool',outcome:{target:pending.calls[0].pending.target,result:{kind:'error',error:{namespace:'fixture',schemaVersion:1,data:{text:'same payload'}}},effect:{kind:'unknown'},delivery:{kind:'unknown'}}}]});assert.equal(result.kind,'complete');state=host.adapter.state();assert.equal(bodies[1].turns.find(row=>row.role==='tool').isError,true);assert.equal(state.turns.find(row=>row.role==='tool').isError,true);}finally{await host.close();}
 const reopened=await open({tools,state,stream:async function*(body){assert.equal(body.turns.find(row=>row.role==='tool').isError,true);yield{kind:'text',text:'reopened'};}});try{assert.equal((await reopened.adapter.run(run('after'))).kind,'complete');}finally{await reopened.close();}
});
test('async Pi state publication rejection preserves accepted failure',async()=>{
 const host=await open({onState:async()=>{throw new Error('async persistence failed');}});try{const result=await host.adapter.run(run('async-store'));assert.equal(result.kind,'failed');assert.equal(result.write.kind,'accepted');}finally{await host.close();}
});


test('public pending snapshots cannot remove private tool obligations',async()=>{
 const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){yield{kind:'tool-call',id:'call-private',name:'lookup',arguments:{}};}});
 try{const pending=await host.adapter.run(run('tool'));assert.equal(pending.kind,'pending');pending.calls.splice(0);const inspected=(await host.adapter.capabilities.inspect.api.pending(openSignal())).value;assert.equal(inspected.calls.length,1);inspected.calls.splice(0);const next=await host.adapter.run(run('fresh',()=>assert.fail('pending calls must refuse before intent')));assert.equal(next.error.code,'busy');assert.equal((await host.adapter.capabilities.inspect.api.pending(openSignal())).value.calls.length,1);}finally{await host.close();}
});
test('legacy state cannot reoffer pending placeholders behind a later assistant',async()=>{
 const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){yield{kind:'tool-call',id:'call-legacy',name:'lookup',arguments:{}};}});
 try{await host.adapter.run(run('tool'));const valid=structuredClone(host.adapter.state());assert(validatePiHostSessionState(valid));valid.turns.push({role:'assistant',text:'already completed',segment:2});assert.equal(validatePiHostSessionState(valid),false);}finally{await host.close();}
});
test('native terminal remains observable while exported state is being saved',async()=>{
 const received=Promise.withResolvers();const saved=Promise.withResolvers();const host=await open({onState(){received.resolve();return saved.promise;}});
 try{const running=host.adapter.run(run('saved'));await received.promise;assert.equal((await host.adapter.interrupt({timeoutMs:10})).kind,'terminal-observed');saved.resolve();assert.equal((await running).kind,'complete');}finally{saved.resolve();await host.close();}
});
test('continuation reads its caller signal once before staging results',async()=>{
 let turns=0;const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){if(++turns===1)yield{kind:'tool-call',id:'call-signal',name:'lookup',arguments:{}};else yield{kind:'text',text:'done'};}});
 try{const pending=await host.adapter.run(run('tool'));let reads=0;const signal=openSignal();const result=await host.adapter.continue({hostOperationId:'signal-once',get signal(){if(++reads>1)throw new Error('second read');return signal;},recordIntent(){},answers:[{formatVersion:1,kind:'tool',outcome:{target:pending.calls[0].pending.target,result:{kind:'ok',value:{namespace:'fixture',schemaVersion:1,data:{ok:true}}},effect:{kind:'unknown'},delivery:{kind:'unknown'}}}]});assert.equal(result.kind,'complete');assert.equal(reads,1);}finally{await host.close();}
});


test('public state copies cannot rewrite recovery history or fingerprints',async()=>{
 const host=await open({onState(state){state.turns.splice(0);}});
 try{await host.adapter.run(run('first'));const before=await host.adapter.capabilities.fingerprint.api.read(openSignal());const view=host.adapter.state();assert(view.turns.some(row=>row.role==='user'&&row.text==='first'));view.turns.splice(0);assert.deepEqual(await host.adapter.capabilities.fingerprint.api.read(openSignal()),before);await host.adapter.run(run('second'));assert(host.adapter.state().turns.some(row=>row.role==='user'&&row.text==='first'));}finally{await host.close();}
});
test('throwing continuation input returns typed refusal and preserves the pending set',async()=>{
 const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){yield{kind:'tool-call',id:'bad-array-call',name:'lookup',arguments:{}};}});
 try{const pending=await host.adapter.run(run('tool'));const bad=[];Object.defineProperty(bad,Symbol.iterator,{get(){throw new Error('bad iterator');}});const result=await host.adapter.continue({hostOperationId:'bad-answers',signal:openSignal(),answers:bad,recordIntent(){assert.fail('invalid input cannot record');}});assert.equal(result.kind,'failed');assert.equal(result.error.code,'invalid-input');assert.equal(result.write.kind,'not-attempted');assert.deepEqual((await host.adapter.capabilities.inspect.api.pending(openSignal())).value.calls,pending.calls);}finally{await host.close();}
});


test('Pi abort rejection preserves an interrupted unknown outcome',async()=>{
 const entered=Promise.withResolvers();const host=await open({stream:async function*(request){entered.resolve();await new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true}));yield{kind:'text',text:''};}});try{const running=host.adapter.run(run('held-abort'));await entered.promise;await host.adapter.interrupt({timeoutMs:1000});const result=await running;assert.equal(result.write.kind,'outcome-unknown');}finally{await host.close();}
});
test('Pi run-started abort reports known non-dispatch',async()=>{
 const host=await open({});const control=new AbortController();try{const result=await host.adapter.run({...run('early-stop'),signal:control.signal,onObservation(event){if(event.kind==='run-started')control.abort();}});assert.equal(host.requests.length,0);assert.deepEqual(result.write,{kind:'not-dispatched',reason:'aborted'});}finally{await host.close();}
});
test('Pi persistence callback is captured before the caller reuses its options',async()=>{
 const states=[];const options={...base,stream:async function*(){yield{kind:'text',text:'done'};},onState(state){states.push(state);}};const opened=await piHostAdapter.open(options,openSignal());assert.equal(opened.kind,'ok');try{delete options.onState;assert.equal((await opened.value.run(run('save'))).kind,'complete');assert.equal(states.length,1);}finally{await opened.value.close();}
});
test('Pi imports an owned state snapshot before asynchronous setup',async()=>{
 const first=await open({});await first.adapter.run(run('original history'));const state=first.adapter.state();await first.close();const seen=[];const pending=piHostAdapter.open({...base,state,stream:async function*(request){seen.push(request);yield{kind:'text',text:'done'};}},openSignal());state.turns.find(turn=>turn.role==='user').text='caller mutation';const second=await pending;assert.equal(second.kind,'ok');try{assert.equal(second.value.state().turns.find(turn=>turn.role==='user').text,'original history');await second.value.run(run('follow-up'));assert.equal(seen[0].turns.find(turn=>turn.role==='user').text,'original history');}finally{await second.value.close();}
});
test('Pi declaration snapshot survives caller catalog mutation',async()=>{
 const tools=[{name:'lookup',description:'Original',inputSchema:{type:'object',properties:{city:{type:'string'}}}}];const host=await open({tools});try{tools[0].name='changed';tools[0].inputSchema.properties.city.type='number';await host.adapter.run(run('catalog'));assert.equal(host.requests[0].tools[0].name,'lookup');assert.equal(host.requests[0].tools[0].inputSchema.properties.city.type,'string');}finally{await host.close();}
});
test('Pi event observers cannot rewrite one anothers tool arguments',async()=>{
 const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){yield{kind:'tool-call',id:'immutable-call',name:'lookup',arguments:{nested:{city:'Paris'}}};}});let immutable;const received=[];host.adapter.events.subscribe(event=>{if(event.kind==='tool-call-end')immutable=!Reflect.set(event.arguments.nested,'city','changed');});host.adapter.events.subscribe(event=>{if(event.kind==='tool-call-end')received.push(event.arguments.nested.city);});try{await host.adapter.run(run('tool'));await new Promise(resolve=>setTimeout(resolve,10));assert.equal(immutable,true);assert.deepEqual(received,['Paris']);}finally{await host.close();}
});
test('Pi refuses a pending result moved beyond a later assistant',async()=>{
 const host=await open({tools:[{name:'lookup',description:'Lookup',inputSchema:{type:'object'}}],stream:async function*(){yield{kind:'tool-call',id:'ordered-call',name:'lookup',arguments:{}};}});try{await host.adapter.run(run('tool'));const state=host.adapter.state();const index=state.turns.findIndex(row=>row.role==='tool');const [placeholder]=state.turns.splice(index,1);state.turns.push({role:'assistant',segment:2,text:'later assistant'},placeholder);assert.equal(validatePiHostSessionState(state),false);}finally{await host.close();}
});
test('Pi reserves the two rows required by a fresh prompt before intent',async()=>{
 const seed=await open({});await seed.adapter.run(run('seed'));const state=seed.adapter.state();await seed.close();state.turns=Array.from({length:127},(_,n)=>({role:n%2?'assistant':'user',segment:Math.floor(n/2)+1,text:'row'}));assert(validatePiHostSessionState(state));const host=await open({state});let intents=0;try{const result=await host.adapter.run(run('no room',()=>{intents++;}));assert.equal(result.kind,'failed');assert.equal(result.write.kind,'not-attempted');assert.equal(intents,0);assert.equal(host.requests.length,0);}finally{await host.close();}
});


test('Pi refuses non-string tool names at the public boundary', async () => {
  for (const name of [undefined, null, ['lookup']]) {
    const result = await piHostAdapter.open({ ...base, tools: [{ name, description: 'Lookup', inputSchema: { type: 'object' } }], stream: async function* () {} }, openSignal());
    if (result.kind === 'ok') await result.value.close();
    assert.equal(result.kind, 'error'); assert.equal(result.error.code, 'invalid-input');
  }
});
test('Pi rejects non-JSON imported tool arguments before hydration', async () => {
  for (const argumentsValue of [{ count: 1n }, { count: NaN }, { when: new Date() }]) {
    const state = { formatVersion: 1, sessionId: 'invalid-json', turns: [
      { segment: 1, role: 'assistant', text: '', toolCalls: [{ id: 'call', name: 'lookup', arguments: argumentsValue }] },
      { segment: 1, role: 'tool', text: '', toolCallId: 'call', name: 'lookup', pending: true },
    ] };
    assert.equal(validatePiHostSessionState(state), false);
    const result = await piHostAdapter.open({ ...base, state, tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], stream: async function* () {} }, openSignal());
    if (result.kind === 'ok') await result.value.close();
    assert.equal(result.kind, 'error'); assert.equal(result.error.code, 'invalid-input');
  }
});
test('Pi refuses a schema-invalid batch before exposing host placeholders', async () => {
  const tools = [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }];
  let requests = 0;
  const host = await open({ tools, stream: async function* () {
    if (++requests > 1) { yield { kind: 'text', text: 'stop' }; return; }
    yield { kind: 'tool-call', id: 'invalid', name: 'lookup', arguments: {} };
    yield { kind: 'tool-call', id: 'valid', name: 'lookup', arguments: { q: 'yes' } };
  } });
  let reopened;
  try {
    const result = await host.adapter.run(run('schema'));
    assert.equal(result.kind, 'failed'); assert.equal(result.write.kind, 'accepted');
    assert.equal(requests, 1);
    assert.equal(host.events.some(event => event.kind === 'tool-call-end'), false);
    const live = await host.adapter.capabilities.inspect.api.pending(openSignal());
    reopened = await open({ tools, state: host.adapter.state() });
    const restored = await reopened.adapter.capabilities.inspect.api.pending(openSignal());
    assert.deepEqual(live.value.calls, []); assert.deepEqual(restored.value.calls, []);
  } finally { await reopened?.close(); await host.close(); }
});
test('Pi cancelled asynchronous open cleans its native session and directory', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const root = await mkdtemp('/tmp/pi-open-abort-'); const original = ModelRuntime.create;
  const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const controller = new AbortController();
  ModelRuntime.create = async (...args) => { entered.resolve(); await release.promise; return Reflect.apply(original, ModelRuntime, args); };
  let opening;
  try {
    opening = piHostAdapter.open({ ...base, environment: { ...base.environment, variables: { ...base.environment.variables, TMPDIR: root } }, stream: async function* () {} }, controller.signal);
    await entered.promise; controller.abort(); release.resolve(); const result = await opening;
    if (result.kind === 'ok') await result.value.close();
    assert.equal(result.kind, 'error'); assert.equal(result.error.code, 'closed'); assert.deepEqual(await readdir(root), []);
  } finally { release.resolve(); ModelRuntime.create = original; await opening?.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});
test('Pi captures malformed run and continuation accessors before dispatch', async () => {
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], stream: async function* () { yield { kind: 'tool-call', id: 'getter', name: 'lookup', arguments: {} }; } });
  try {
    const pending = await host.adapter.run(run('getter')); const before = host.requests.length;
    const malformedRun = { ...run('bad'), get prompt() { throw new Error('prompt canary'); } };
    const result = await host.adapter.run(malformedRun);
    assert.equal(result.kind, 'failed'); assert.equal(result.error.code, 'invalid-input'); assert.equal(result.write.kind, 'not-attempted');
    const answer = { formatVersion: 1, kind: 'tool', outcome: { target: pending.calls[0].pending.target, result: { kind: 'ok', value: { namespace: 'fixture', schemaVersion: 1, data: 'done' } }, effect: { kind: 'unknown' }, delivery: { kind: 'unknown' } } };
    const continued = await host.adapter.continue({ hostOperationId: 'getter-answer', signal: openSignal(), answers: [answer], get recordIntent() { throw new Error('intent canary'); } });
    assert.equal(continued.kind, 'failed'); assert.equal(continued.error.code, 'invalid-input'); assert.equal(continued.write.kind, 'not-attempted'); assert.equal(host.requests.length, before);
  } finally { await host.close(); }
});
test('Pi event wrappers cannot change arguments or target for later observers', async () => {
  const host = await open({ tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }], stream: async function* () { yield { kind: 'tool-call', id: 'original-id', name: 'lookup', arguments: { original: true } }; } });
  const seen = []; const changed = [];
  host.adapter.events.subscribe(event => { if (event.kind === 'tool-call-end') changed.push(Reflect.set(event, 'arguments', { changed: true }), Reflect.set(event.target, 'nativeToolCallId', 'changed')); });
  host.adapter.events.subscribe(event => { if (event.kind === 'tool-call-end') seen.push(structuredClone(event)); });
  try {
    await host.adapter.run(run('facts')); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(changed, [false, false]); assert.equal(seen[0].target.nativeToolCallId, 'original-id'); assert.deepEqual(seen[0].arguments, { original: true });
  } finally { await host.close(); }
});
