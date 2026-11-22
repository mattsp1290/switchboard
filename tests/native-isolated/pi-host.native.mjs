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
    ...base, ...extra, onState: (state) => { states.push(state); extra.onState?.(state); },
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
