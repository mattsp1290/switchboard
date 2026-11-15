import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const [tarball, destinations, outputPath] = process.argv.slice(2);
const directory = fileURLToPath(new URL('.', import.meta.url));
const options = { cwd: directory, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 };
const npm = process.env.npm_execpath;
await writeFile(new URL('./package.json', import.meta.url), JSON.stringify({ private: true, type: 'module' }));
await execute(npm ? process.execPath : 'npm', [...(npm ? [npm] : []), 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', tarball,
  '@opentelemetry/api@1.9.0', '@opentelemetry/resources@2.12.0', '@opentelemetry/sdk-trace-node@2.12.0',
  '@opentelemetry/sdk-trace-base@2.12.0', '@opentelemetry/exporter-trace-otlp-proto@0.223.0'], options);
await execute(process.execPath, [fileURLToPath(new URL('./observability-backend-consumer.mjs', import.meta.url)), destinations, outputPath], options);
