// The pinned image is Debian glibc. A macOS install has only the host's optional platform
// package, so the Linux container must receive the lockfile's matching package instead.
import assert from 'node:assert/strict';

const CPU = { aarch64: 'arm64', x86_64: 'x64' };

/** Optional lockfile packages the container can load. Host-only and musl-only packages stay out. */
export function containerPlatformPackages(lockPackages, optionalNames, machine) {
  const cpu = CPU[machine];
  assert(cpu, `no container platform for Docker architecture ${machine}`);
  const names = [];
  for (const name of optionalNames) {
    const entry = lockPackages[`node_modules/${name}`];
    if (!entry?.resolved || !entry.integrity) continue;
    if (!entry.os?.includes('linux') || !entry.cpu?.includes(cpu)) continue;
    if (entry.libc && !entry.libc.includes('glibc')) continue;
    names.push(name);
  }
  return names;
}
