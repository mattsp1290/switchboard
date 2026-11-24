import * as fs from 'node:fs/promises';
export const { realpath } = fs;
let listing;
export function changeListing(fn) { listing = fn; }
export async function readdir(path, options) { await listing?.(path); return fs.readdir(path, options); }
let identity;
export function changeIdentity(fn) { identity = fn; }
export async function lstat(path, options) { const result = await fs.lstat(path, options); return identity?.('name', result) ?? result; }
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
    stat: async (options) => { const actual = await file.stat(options); const result = identity?.('descriptor', actual) ?? actual; openingSize ??= Number(result.size); if (readFinished && finalStat) { const hook = finalStat; finalStat = undefined; await hook(path); } return result; }, close: () => file.close(),
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
