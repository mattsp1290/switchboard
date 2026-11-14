export const mkdirSync = () => {};
export const existsSync = () => true;
export const lstatSync = (path) => ({
  isDirectory: () => false,
  isFile: () => path.endsWith('/sessions'),
  isSymbolicLink: () => false,
});
export const readdirSync = () => ['sessions'];
export const readFileSync = (path) => path === '/opt/records.json' ? '[]' : 'synthetic invalid directory';
export const writeFileSync = () => { throw Object.assign(new Error('fixture'), { code: 'ENOTDIR' }); };
export const readlinkSync = () => { throw new Error('Unexpected readlink'); };
export const createServer = () => ({
  listen(_port, _host, callback) { callback(); },
  address() { return { port: 12345 }; },
  closeAllConnections() {},
  close(callback) { callback(); },
});
