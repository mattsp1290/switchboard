export const execFileSync = (...args) => globalThis.codexQualification.run(...args);
export const spawn = () => { throw new Error('Unexpected native spawn'); };
