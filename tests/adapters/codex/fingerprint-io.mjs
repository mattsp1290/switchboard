import * as fs from 'node:fs/promises';
export const { lstat, readdir } = fs;
let scenario;
export function changeRead(fn) { scenario = fn; }
export async function open(path, flags) {
  const file = await fs.open(path, flags);
  let first = true;
  return {
    stat: () => file.stat(), close: () => file.close(),
    async read(...args) {
      if (first && scenario) {
        first = false;
        if (await scenario(path)) return { bytesRead: 0 };
      }
      return file.read(...args);
    },
  };
}
