export * from 'node:fs';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
export function readFileSync(path, ...options) {
  if (String(path).endsWith('/pins.json')) {
    const pins = JSON.parse(fs.readFileSync(path, 'utf8'));
    for (const pin of Object.values(pins.artifacts)) pin.sha512 = createHash('sha512').update('inert archive').digest('base64');
    return JSON.stringify(pins);
  }
  if (String(path).includes('/node_modules/')) return JSON.stringify({ version: String(path).includes('typescript') ? '7.0.2' : '24.19.2' });
  return fs.readFileSync(path, ...options);
}
export const mkdtempSync = () => globalThis.codexQualification.work;
export const chmodSync = () => {};
export const mkdirSync = (path, ...options) => String(path).endsWith('/codex-native/.work') ? undefined : fs.mkdirSync(path, ...options);
