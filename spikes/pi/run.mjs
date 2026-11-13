import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.version, "v24.22.3", "Run with the qualified Node binary");
const npm = process.argv[2];
assert.ok(npm, "Pass the absolute npm 11.19.1 CLI script path");
assert.equal(resolve(npm), npm);
const source = dirname(fileURLToPath(import.meta.url));
assert.equal(process.platform, "darwin", "Fixture isolation currently requires macOS sandbox-exec");
const work = realpathSync(mkdtempSync(join(tmpdir(), "switchboard-pi-selection-")));
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PI_OFFLINE: "1", TMPDIR: join(work, "tmp"),
  PI_CODING_AGENT_DIR: join(work, "agent"),
  npm_config_userconfig: join(work, "user.npmrc"),
  npm_config_globalconfig: join(work, "global.npmrc"),
  npm_config_cache: join(work, "npm-cache"),
};
mkdirSync(env.TMPDIR);
writeFileSync(env.npm_config_userconfig, "registry=https://registry.npmjs.org/\n");
writeFileSync(env.npm_config_globalconfig, "");
const sandbox = join(work, "fixtures.sb");
const literal = (path) => `(literal ${JSON.stringify(realpathSync(path))})`;
const fixtureDirectory = `(subpath ${JSON.stringify(work)})`;
const hostUserDirectory = realpathSync(homedir());
const deniedFixture = join(work, "isolation-denied");
writeFileSync(deniedFixture, "synthetic inaccessible fixture");
assert.ok(!work.startsWith(`${hostUserDirectory}/`), "Use a temporary directory outside the production home");
const outside = (filters) => `(require-all ${filters.map((filter) => `(require-not ${filter})`).join(" ")})`;
writeFileSync(sandbox, `(version 1)\n(allow default)\n(deny network*)\n` +
  `(deny file-read* file-test-existence (require-all (subpath ${JSON.stringify(hostUserDirectory)}) (require-not ${literal(process.execPath)})))\n` +
  `(deny file-read* file-test-existence ${literal(deniedFixture)})\n` +
  `(deny file-write* ${outside([fixtureDirectory, literal("/dev/null")])})\n` +
  `(deny process-exec ${outside([...[process.execPath, "/bin/sh", "/bin/bash", "/bin/cat"].map(literal),
    `(literal ${JSON.stringify(join(work, `node_modules/@typescript/typescript-darwin-${process.arch}/lib/tsc`))})`])})\n`);
function run(args, name, confined = true) {
  const result = spawnSync(confined ? "/usr/bin/sandbox-exec" : process.execPath,
    confined ? ["-f", sandbox, process.execPath, "--permission", `--allow-fs-read=${work}`,
      `--allow-fs-read=${join(hostUserDirectory, ".agents/skills")}`,
      `--allow-fs-write=${work}`, "--allow-child-process", ...args] : args, {
    cwd: work, env, encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  writeFileSync(join(work, `${name}.log`), result.stdout + result.stderr);
  return result;
}
assert.equal(run([npm, "--version"], "npm-version", false).stdout.trim(), "11.19.1");
for (const file of ["package.json", "package-lock.json", "tsconfig.json", "public-api.ts", "public-models.ts", "fixtures.test.mjs"]) {
  copyFileSync(join(source, file), join(work, file));
}
const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  assert.match(entry.integrity, /^sha512-/);
  assert.ok(entry.resolved.startsWith("https://registry.npmjs.org/"));
}
console.log(`Evidence directory: ${work}`);
const install = run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "install", false);
assert.equal(install.status, 0, install.stderr);
const isolation = run(["--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import { existsSync, readFileSync, writeFileSync } from 'node:fs';
  import { spawnSync } from 'node:child_process';
  import { createServer } from 'node:net';
  assert.equal(process.env.HOME, undefined);
  assert.throws(() => readFileSync('/etc/hosts'), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => writeFileSync('/tmp/switchboard-pi-outside-denied', ''), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => readFileSync(${JSON.stringify(deniedFixture)}), { code: 'EPERM' });
  assert.equal(existsSync(${JSON.stringify(deniedFixture)}), false);
  assert.equal(existsSync(${JSON.stringify(join(hostUserDirectory, ".agents/skills"))}), false);
  const child = spawnSync('/bin/cat', [${JSON.stringify(deniedFixture)}],
    { encoding: 'utf8', timeout: 1000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Operation not permitted/);
  const server = createServer();
  server.once('error', (error) => assert.equal(error.code, 'EPERM'));
  server.once('listening', () => { server.close(); assert.fail('Network sandbox did not deny listen'); });
  server.listen(0, '127.0.0.1');
`], "isolation", true);
assert.equal(isolation.status, 0, `${isolation.signal ?? ""} ${isolation.stderr}`);
const compiler = join(work, "node_modules/typescript/bin/tsc");
assert.equal(run([compiler, "--version"], "typescript-version", true).stdout.trim(), "Version 7.0.2");
assert.equal(JSON.parse(readFileSync(join(work, "node_modules/@types/node/package.json"))).version, "24.19.2");
const fixtures = run(["--test", "--test-reporter=tap", "fixtures.test.mjs"], "fixtures");
console.log(fixtures.stdout + fixtures.stderr);
assert.equal(fixtures.status, 0, "Fixture probe failed");
const fixtureTestsPassed = Number(/^# pass (\d+)$/m.exec(fixtures.stdout)?.[1]);
assert.equal(fixtureTestsPassed, 6);
const declarations = run([compiler, "--project", "tsconfig.json"], "declarations", true);
console.log(declarations.stdout + declarations.stderr);
const modelConfig = JSON.parse(readFileSync(join(work, "tsconfig.json"), "utf8"));
modelConfig.include = ["public-models.ts"];
writeFileSync(join(work, "models-tsconfig.json"), JSON.stringify(modelConfig));
const models = run([compiler, "--project", "models-tsconfig.json"], "models-declarations", true);
console.log(models.stdout + models.stderr);
const report = {
  node: process.version, npm: "11.19.1", typescript: "7.0.2", nodeTypes: "24.19.2",
  lockSha256: createHash("sha256").update(readFileSync(join(source, "package-lock.json"))).digest("hex"),
  fixturesExit: fixtures.status, declarationsExit: declarations.status, modelsDeclarationsExit: models.status,
  isolationExit: isolation.status, isolation: "Node filesystem permissions and macOS sandbox-exec",
  fixtureTestsPassed, rootDeclarationDiagnostics: (declarations.stdout.match(/error TS\d+:/g) ?? []).length,
  modelsDeclarationDiagnostics: (models.stdout.match(/error TS\d+:/g) ?? []).length,
  nativeTurns: 0, providerRequests: 0, liveQualified: false,
};
writeFileSync(join(work, "result.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
process.exitCode = declarations.status === 0 && models.status === 0 ? 0 : 1;
