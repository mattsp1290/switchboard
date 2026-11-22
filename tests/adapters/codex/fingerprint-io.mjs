import * as fs from 'node:fs/promises';
export const { lstat, readdir, realpath } = fs;
let scenario;
let step;
export function changeReadStep(fn) { step = fn; }
let finalStat;
let beforeOpen;
let reads = 0;
export function changeOpen(fn) { beforeOpen = fn; reads = 0; }
export const contentReads = () => reads;
export function changeFinalStat(fn) { finalStat = fn; }
export function changeRead(fn) { scenario = fn; }
export async function open(path, flags) {
  if (beforeOpen) { const run = beforeOpen; beforeOpen = undefined; await run(path); }
  const file = await fs.open(path, flags);
  let first = true;
  let openingSize;
  let readFinished = false;
  return {
    stat: async () => { const result = await file.stat(); openingSize ??= result.size; if (readFinished && finalStat) { const hook = finalStat; finalStat = undefined; await hook(path); } return result; }, close: () => file.close(),
    async read(...args) {
      reads++;
      await step?.(path, args[3]);
      if (first && scenario) {
        first = false;
        if (await scenario(path)) { readFinished = true; return { bytesRead: 0 }; }
      }
      const result = await file.read(...args);
      if (result.bytesRead === 0 || args[3] + result.bytesRead >= openingSize) readFinished = true;
      return result;
    },
  };
}
