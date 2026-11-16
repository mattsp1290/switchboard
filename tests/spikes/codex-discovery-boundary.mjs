// Total in-memory fake for discovery's node:fs and node:http: one protected root holding a regular `sessions` file.
const bytes = Buffer.from('synthetic invalid directory');
const stat = (directory) => ({ dev: 1, ino: directory ? 2 : 3, size: directory ? 64 : bytes.length, mode: directory ? 0o40555 : 0o100444,
  nlink: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false });
const absent = () => { throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' }); };
export const constants = { O_RDONLY: 0, O_NOFOLLOW: 0, O_NONBLOCK: 0 };
export const mkdirSync = () => {};
export const lstatSync = (path) => path === '/root/.codex' ? stat(true) : path === '/root/.codex/sessions' ? stat(false) : absent();
export const opendirSync = () => { const names = ['sessions']; return { readSync: () => names.length ? { name: names.shift() } : null, closeSync() {} }; };
export const openSync = (path) => path === '/root/.codex/sessions' ? 3 : absent();
export const fstatSync = () => stat(false);
export const readSync = (_fd, buffer, offset, length, position) => bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length));
export const closeSync = () => {};
export const readFileSync = (path) => path === '/opt/records.json' ? '[]' : 'synthetic invalid directory';
export const writeFileSync = () => { throw Object.assign(new Error('fixture'), { code: 'ENOTDIR' }); };
export const createServer = () => ({
  listen(_port, _host, callback) { callback(); },
  address() { return { port: 12345 }; },
  closeAllConnections() {},
  close(callback) { callback(); },
});
