import * as fs from 'node:fs/promises';
export const { lstat, readdir, realpath } = fs;
let scenario;
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
  let stats = 0;
  return {
    stat: async () => { const result = await file.stat(); if (++stats === 2 && finalStat) await finalStat(path); return result; }, close: () => file.close(),
    async read(...args) {
      reads++;
      if (first && scenario) {
        first = false;
        if (await scenario(path)) return { bytesRead: 0 };
      }
      return file.read(...args);
    },
  };
}
