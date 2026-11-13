import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, copyFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert.equal(process.version, 'v24.22.3');
assert.equal(process.platform, 'darwin', 'fixture network denial requires macOS sandbox-exec');
assert.equal(process.arch, 'arm64', 'compiler binary pin is darwin-arm64');
assert.ok(process.argv[2]?.startsWith('/'), 'supply the absolute npm 11.19.1 executable path');
const here = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(await readFile(join(here, 'pins.json'), 'utf8'));
const root = await realpath(await mkdtemp(join(tmpdir(), 'switchboard-codex-')));
const env = { SWITCHBOARD_FIXTURE_ROOT: root, npm_config_cache: join(root, 'npm-cache'),
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  npm_config_userconfig: join(root, '.npmrc'), npm_config_globalconfig: join(root, 'global.npmrc') };
const report = [];
const check = async (name, probe) => { await probe(); report.push(name); };
const read = path => readFile(path, 'utf8');
const digest = (data, algorithm, encoding) => createHash(algorithm).update(data).digest(encoding);
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, url);
  return Buffer.from(await response.arrayBuffer());
}
try {
  await writeFile(env.npm_config_userconfig, '');
  await writeFile(env.npm_config_globalconfig, '');
  assert.equal(execFileSync(process.argv[2], ['--version'], { env, cwd: root, encoding: 'utf8', timeout: 5000 }).trim(), '11.19.1');
  await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  for (const artifact of pins.artifacts) {
    const data = await download(artifact.url);
    assert.equal('sha512-' + digest(data, 'sha512', 'base64'), artifact.integrity);
    const dest = join(root, 'node_modules', artifact.name);
    await mkdir(dest, { recursive: true });
    const archive = join(root, 'artifact.tgz');
    await writeFile(archive, data);
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { env });
    assert.equal(JSON.parse(await read(join(dest, 'package.json'))).version, artifact.version);
  }
  const source = {};
  for (const pin of pins.sources) {
    const data = await download(`https://raw.githubusercontent.com/openai/codex/${pins.codexCommit}/${pin.path}`);
    assert.equal(digest(data, 'sha256', 'hex'), pin.sha256);
    source[pin.path] = data.toString('utf8');
  }
  await check('exact artifacts and toolchain; no install scripts or native Codex binary', async () => {
    assert.equal(execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--version'],
      { env, encoding: 'utf8' }).trim(), 'Version 7.0.2');
    const pkg = JSON.parse(await read(join(root, 'node_modules/@openai/codex-sdk/package.json')));
    assert.deepEqual(pkg.dependencies, { '@openai/codex': '0.169.0' });
    assert.ok(pkg.devDependencies['@modelcontextprotocol/sdk']);
    assert.match(await read(join(root, 'node_modules/@openai/codex-sdk/LICENSE')), /Apache License/);
    assert.match(source.LICENSE, /Apache License/);
    const cli = JSON.parse(await read(join(root, 'node_modules/@openai/codex/package.json')));
    assert.equal(cli.dependencies, undefined);
    assert.ok(Object.keys(cli.optionalDependencies).every(name => name.startsWith('@openai/codex-')));
  });
  await copyFile(join(here, 'declarations.ts'), join(root, 'declarations.ts'));
  const config = { compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext',
    target: 'ES2022', lib: ['ES2022'], types: ['node'], noEmit: true, skipLibCheck: false,
    noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true }, files: ['declarations.ts'] };
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  await check('SDK declarations fail TS2307 on undeclared MCP dependency with skipLibCheck:false', async () => {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', root],
      { env, cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /TS2307.*@modelcontextprotocol\/sdk\/types.js/);
    assert.equal((result.stdout.match(/error TS/g) ?? []).length, 1, result.stdout);
    process.stdout.write(result.stdout.replaceAll(root, '<fixture>'));
  });
  await writeFile(join(root, 'node-only.ts'), 'export const signal: AbortSignal = AbortSignal.timeout(1);\n');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ ...config, files: ['node-only.ts'] }));
  await check('Node-only ES2022 strict control compiles without DOM', async () => {
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', root], { env });
  });
  await check('pinned native schema exposes Responses, command refresh, retry and discovery controls', () => {
    const schema = JSON.parse(source['codex-rs/core/config.schema.json']).definitions;
    assert.deepEqual(schema.WireApi.oneOf[0].enum, ['responses']);
    const auth = schema.ModelProviderAuthInfo;
    assert.deepEqual(auth.required, ['command']);
    assert.equal(auth.properties.refresh_interval_ms.default, 300000);
    assert.equal(auth.properties.timeout_ms.default, 5000);
    for (const key of ['auth', 'base_url', 'supports_websockets', 'request_max_retries', 'stream_max_retries']) {
      assert.ok(schema.ModelProviderInfo.properties[key], key);
    }
    const list = source['codex-rs/app-server-protocol/schema/typescript/v2/ThreadListParams.ts'];
    for (const field of ['cursor?', 'sourceKinds?', 'modelProviders?', 'useStateDbOnly?', 'archived?']) assert.ok(list.includes(field));
    assert.match(list, /defaults to interactive sources/);
    assert.match(source['codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts'], /threadId: string/);
    const methods = source['codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts'];
    for (const method of ['thread/list', 'thread/read', 'thread/resume', 'turn/start', 'turn/interrupt']) assert.ok(methods.includes(`"${method}"`));
    const requests = source['codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts'];
    for (const method of ['item/commandExecution/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'account/chatgptAuthTokens/refresh']) assert.ok(requests.includes(`"${method}"`));
    const authSource = source['codex-rs/login/src/auth/external_bearer.rs'];
    assert.match(authSource, /cached_token.fetched_at.elapsed\(\) < refresh_interval/);
    assert.match(authSource, /tokio::time::timeout/);
    assert.match(authSource, /produced an empty token/);
    const responses = source['codex-rs/codex-api/src/endpoint/responses.rs'];
    assert.match(responses, /Method::POST/);
    assert.ok(responses.includes('"/responses"'));
    assert.ok(responses.includes('"text/event-stream"'));
    assert.match(responses, /spawn_response_stream/);
  });
  await check('AI harness rejects native approval requests and pins older CLI; ACP embeds older Rust', async () => {
    const harness = join(root, 'node_modules/@ai-sdk/harness-codex');
    const driver = await read(join(harness, 'src/bridge/codex-app-server-driver.ts'));
    assert.match(driver, /request.method !== 'item\/tool\/call'/);
    assert.match(driver, /approvalPolicy: 'never'/);
    assert.equal(JSON.parse(await read(join(harness, 'dist/bridge/package.json'))).dependencies['@openai/codex'], '0.167.0');
    const cargo = await download(`https://raw.githubusercontent.com/zed-industries/codex-acp/${pins.acpCommit}/Cargo.toml`);
    assert.equal(digest(cargo, 'sha256', 'hex'), pins.acpCargoSha256);
    assert.match(cargo.toString(), /codex-core = .*rust-v0.137.0/);
  });
  const peer = join(root, 'peer.mjs');
  await copyFile(join(here, 'fixture-peer.mjs'), peer);
  const launcher = join(root, 'fixture-cli');
  await writeFile(launcher, '#!/bin/sh\nexec /usr/bin/sandbox-exec -p ' +
    shellQuote('(version 1)(allow default)(deny network*)') + ' ' + shellQuote(process.execPath) +
    ' --permission ' + shellQuote(`--allow-fs-read=${root}`) + ' ' + shellQuote(`--allow-fs-write=${root}`) +
    ' ' + shellQuote(peer) + ' "$@"\n');
  await chmod(launcher, 0o700);
  const { Codex } = await import(pathToFileURL(join(root, 'node_modules/@openai/codex-sdk/dist/index.js')).href);
  const trace = join(root, 'trace.jsonl');
  const client = new Codex({ codexPathOverride: launcher, env: { ...env, TRACE: trace },
    apiKey: 'fixture-proxy-token', config: { model_provider: 'fixture', model_providers: { fixture: {
      name: 'Fixture', base_url: 'http://127.0.0.1:1/v1', wire_api: 'responses', supports_websockets: false,
      request_max_retries: 0, stream_max_retries: 0,
      auth: { command: '/not-executed/fixture-token', args: ['rotate'], refresh_interval_ms: 1000 },
    } } }, configOverrides: ['features.example_native_extension=true'] });
  const collect = async (thread, input, options = {}) => {
    const events = [];
    const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(options.signal ? [options.signal] : [])]);
    for await (const event of (await thread.runStreamed(input, { ...options, signal })).events) events.push(event);
    return events;
  };
  await check('SDK stream preserves unknown payload, native identity, resume and provider config', async () => {
    const thread = client.resumeThread('external-native-id');
    assert.equal(thread.id, 'external-native-id');
    const events = await collect(thread, 'success');
    assert.equal(thread.id, 'native-fixture-id');
    assert.deepEqual(events.find(event => event.type === 'future.event'), { type: 'future.event', opaque: { nested: ['preserve', 7] } });
    assert.equal(events.at(-1).usage.cache_write_input_tokens, 0);
    const call = JSON.parse((await read(trace)).trim().split('\n').at(-1));
    assert.deepEqual(call.args.slice(-2), ['resume', 'external-native-id']);
    for (const value of ['model_provider="fixture"', 'model_providers.fixture.base_url="http://127.0.0.1:1/v1"',
      'model_providers.fixture.wire_api="responses"', 'model_providers.fixture.auth.command="/not-executed/fixture-token"',
      'model_providers.fixture.supports_websockets=false', 'model_providers.fixture.request_max_retries=0',
      'model_providers.fixture.stream_max_retries=0', 'features.example_native_extension=true']) assert.ok(call.args.includes(value), value);
    assert.equal(call.key, 'fixture-proxy-token');
    assert.equal(call.fixtureRoot, root);
  });
  await check('SDK parse failure and child exit reject once; no wrapper retry', async () => {
    for (const input of ['malformed', 'exit']) {
      const before = (await read(trace)).trim().split('\n').length;
      await assert.rejects(collect(client.startThread(), input), input === 'exit' ? /code 9/ : /Failed to parse/);
      assert.equal((await read(trace)).trim().split('\n').length, before + 1);
    }
    await assert.rejects(client.startThread().run('failure', { signal: AbortSignal.timeout(5000) }), /fixture failed/);
  });
  await check('SDK buffered run accepts EOF or fatal event without terminal success; host must detect uncertainty', async () => {
    const eof = await client.startThread().run('eof', { signal: AbortSignal.timeout(5000) });
    assert.equal(eof.finalResponse, 'fixture answer');
    assert.equal(eof.usage, null);
    const fatal = await client.startThread().run('fatal', { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(fatal, { items: [], finalResponse: '', usage: null });
  });
  await check('AbortSignal stops fixture process and reports interruption', async () => {
    const controller = new AbortController();
    let started = false;
    await assert.rejects(async () => {
      for await (const event of (await client.startThread().runStreamed('abort', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) })).events) {
        if (event.type === 'turn.started') { started = true; controller.abort(); }
      }
    }, /abort|SIGTERM/i);
    assert.equal(started, true, 'cancellation follows a started turn, not only a timeout');
  });
  process.stdout.write(JSON.stringify({ status: 'fixture-probes-passed-selection-provisional', checks: report,
    liveNative: false, liveLiteLLM: false, sdkDeclarations: 'blocked-TS2307' }, null, 2) + '\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
