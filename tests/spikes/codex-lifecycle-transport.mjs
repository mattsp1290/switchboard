export const execFileSync = (...args) => globalThis.codexQualification.run(...args);
export const spawn = () => {
  if (globalThis.codexDiscovery) return globalThis.codexDiscovery;
  throw new Error('Unexpected native spawn');
};
