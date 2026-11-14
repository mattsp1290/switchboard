export const lstatSync = () => ({ isSymbolicLink: () => false, isFile: () => true });
export function opendirSync() { throw new Error('No native fixture I/O in inert transport test'); }
export const readFileSync = opendirSync;
export const realpathSync = opendirSync;
