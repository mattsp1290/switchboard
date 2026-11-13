import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

const config = {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-only",
  models: [{ id: "fixture-alias", name: "Fixture", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1024, maxTokens: 64 }],
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "switchboard-pi-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function runtime(credentials = new InMemoryCredentialStore()) {
  return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
}
function user(text) {
  return { role: "user", content: text, timestamp: 1 };
}

test("SDK-created external fixture lists, reopens, and preserves opaque extension data", async (t) => {
  const root = await fixture(t);
  const producer = SessionManager.create(root, join(root, "sessions"));
  producer.appendMessage(user("external fixture"));
  producer.appendCustomEntry("unknown.vendor", { opaque: [1, { keep: true }] });
  const file = producer.getSessionFile();
  assert.ok(file);
  const before = await readFile(file, "utf8");
  const listed = await SessionManager.list(root, join(root, "sessions"));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, producer.getSessionId());
  const resumed = SessionManager.open(file, join(root, "sessions"));
  assert.equal(resumed.getSessionId(), producer.getSessionId());
  assert.deepEqual(resumed.getEntries().at(-1).data, { opaque: [1, { keep: true }] });
  assert.equal(await readFile(file, "utf8"), before);
  resumed.appendMessage(user("continued fixture"));
  assert.equal(SessionManager.open(file).getEntries().length, 3);
});

test("corrupt nonempty fixture is rejected without rewriting", async (t) => {
  const root = await fixture(t);
  const file = join(root, "broken.jsonl");
  await writeFile(file, "not a pi session\n");
  assert.throws(() => SessionManager.open(file, root), /not a valid/);
  assert.equal(await readFile(file, "utf8"), "not a pi session\n");
});

test("two native writers are admitted and create competing branches", async (t) => {
  const root = await fixture(t);
  const first = SessionManager.create(root, root);
  const parent = first.appendMessage(user("parent"));
  const second = SessionManager.open(first.getSessionFile(), root);
  first.appendMessage(user("writer one"));
  second.appendMessage(user("writer two"));
  const entries = SessionManager.open(first.getSessionFile(), root).getEntries();
  assert.equal(entries.length, 3);
  assert.equal(entries[1].parentId, parent);
  assert.equal(entries[2].parentId, parent);
});

test("explicit provider, API, alias, endpoint, and command credential renewal", async (t) => {
  const root = await fixture(t);
  const file = join(root, "synthetic-key");
  await writeFile(file, "fixture-one");
  const models = await runtime();
  models.registerProvider("fixture-proxy", { ...config, apiKey: `!cat '${file}'` });
  const model = models.getModel("fixture-proxy", "fixture-alias");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, config.baseUrl);
  assert.equal((await models.getAuth(model)).auth.apiKey, "fixture-one");
  await writeFile(file, "fixture-two");
  assert.equal((await models.getAuth(model)).auth.apiKey, "fixture-two");
  await rm(file);
  await assert.rejects(models.getAuth(model), /Failed to resolve/);
});

test("host credential store can renew through a bounded host command", async (t) => {
  const root = await fixture(t);
  const file = join(root, "host-key");
  const store = new InMemoryCredentialStore();
  const execute = promisify(execFile);
  const credentials = {
    read: async (provider) => provider === "host-proxy"
      ? { type: "api_key", key: (await execute("/bin/cat", [file], { timeout: 1000, maxBuffer: 256, env: {} })).stdout.trim() }
      : undefined,
    list: (...args) => store.list(...args),
    modify: (...args) => store.modify(...args),
    delete: (...args) => store.delete(...args),
  };
  const models = await runtime(credentials);
  const { apiKey: _unused, ...withoutStaticKey } = config;
  models.registerProvider("host-proxy", withoutStaticKey);
  await writeFile(file, "host-one");
  assert.equal((await models.getAuth("host-proxy")).auth.apiKey, "host-one");
  await writeFile(file, "host-two");
  assert.equal((await models.getAuth("host-proxy")).auth.apiKey, "host-two");
});

test("native extensions can replace providers and hook exceptions do not enforce policy", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const models = await runtime();
  models.registerProvider("fixture-proxy", config);
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    noContextFiles: true, systemPrompt: "",
    extensionFactories: [(pi) => {
      pi.registerProvider("fixture-proxy", { ...config, baseUrl: "https://direct.invalid/v1" });
      pi.on("before_provider_headers", () => { throw new Error("fixture-policy-denied"); });
      pi.on("before_provider_request", () => ({ model: "changed-by-extension" }));
    }],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  for (const registration of loaded.runtime.pendingProviderRegistrations) {
    models.registerProvider(registration.name, registration.config);
  }
  assert.equal(models.getModel("fixture-proxy", "fixture-alias").baseUrl, "https://direct.invalid/v1");
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root,
    SessionManager.inMemory(root), new ModelRegistry(models));
  const errors = [];
  runner.onError((error) => errors.push(error));
  assert.deepEqual(await runner.emitBeforeProviderHeaders({ Authorization: "Bearer fixture" }),
    { Authorization: "Bearer fixture" });
  assert.equal(errors[0].error, "fixture-policy-denied");
  assert.deepEqual(await runner.emitBeforeProviderRequest({ model: "fixture-alias" }),
    { model: "changed-by-extension" });
});
