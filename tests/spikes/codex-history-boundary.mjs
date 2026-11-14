export * from 'node:fs';
import * as fs from 'node:fs';
import { basename, join } from 'node:path';

const state = () => globalThis.codexHistory;
const mapped = (path) => String(path).replace('/root/.codex', join(state().work, 'source')).replace(/^\/tmp\//, `${state().work}/`);
export const existsSync = (path) => fs.existsSync(mapped(path));
export const readdirSync = (path, ...options) => fs.readdirSync(mapped(path), ...options);
export const readFileSync = (path, ...options) => {
  if (path === '/opt/records.json') return JSON.stringify(state().records);
  if (path === '/opt/inventory.json') return JSON.stringify(state().inventory);
  return fs.readFileSync(mapped(path), ...options);
};
export const lstatSync = (path) => {
  const stat = fs.lstatSync(mapped(path));
  if (state().fault === 'aggregate' && String(path).endsWith('thread_history_1.sqlite')) Object.defineProperty(stat, 'size', { value: 9 * 1024 * 1024 });
  return stat;
};
export const mkdirSync = (path, ...options) => fs.mkdirSync(mapped(path), ...options);
export const writeFileSync = () => { throw Object.assign(new Error('Protected original'), { code: 'EROFS' }); };
export const readlinkSync = (path) => fs.readlinkSync(mapped(path));
export const copyFileSync = (source, destination, flags) => {
  state().copies.push(destination);
  const affected = destination.includes(state().affected);
  if (affected && state().fault === 'copy') throw new Error('Synthetic copy failure');
  if (affected && state().fault === 'sidecar' && destination.endsWith('-wal')) throw new Error('Synthetic sidecar failure');
  if (affected && state().fault === 'missing-sidecar' && destination.endsWith('-wal')) return;
  if (affected && state().fault === 'alias') return fs.linkSync(mapped(source), mapped(destination));
  if (affected && state().fault === 'alias-reader') return fs.linkSync(state().affected === 'accountA' ? mapped(source)
    : join(state().work, 'private-index-accountA', basename(source)), mapped(destination));
  if (affected && state().fault === 'partial') return fs.writeFileSync(mapped(destination), 'partial');
  if (affected && state().fault === 'destination-hash') {
    const bytes = fs.readFileSync(mapped(source));
    bytes[0] ^= 1;
    return fs.writeFileSync(mapped(destination), bytes);
  }
  fs.copyFileSync(mapped(source), mapped(destination), flags);
  if (affected && state().fault === 'injected') fs.writeFileSync(join(mapped(destination), '..', 'unexpected.sqlite'), 'unexpected');
  if (affected && state().fault === 'changed') fs.appendFileSync(mapped(source), 'changed source');
};
export const spawn = (...args) => state().spawn(...args);
export const createServer = () => ({
  listen(_port, _host, callback) { callback(); },
  address() { return { port: ++state().port }; },
  closeAllConnections() {},
  close(callback) { callback(); },
});
