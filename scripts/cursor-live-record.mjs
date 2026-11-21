import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The qualification file. Caller secrets, prompts, and paths are not fields. */
export function qualificationBody(local, attempts) {
  return `${JSON.stringify({
    sdk: '1.4.2',
    sandbox: local.sandboxOptions.enabled,
    settingSources: [...local.settingSources],
    modelSupplied: true,
    firstTurn: 'completed',
    followUp: 'completed',
    toolCompleted: true,
    fileCreated: true,
    fileUpdated: true,
    resumedSameAgent: true,
    attempts,
  }, null, 2)}\n`;
}

/** Replaces the record only after the temp file is written. A failed rename leaves the previous bytes. */
export async function replaceRecord(directory, recordPath, body, io = {}) {
  const write = io.writeFile ?? writeFile;
  const move = io.rename ?? rename;
  const remove = io.rm ?? rm;
  const temporary = join(directory, `.cursor-live-${io.pid ?? process.pid}.json`);
  await write(temporary, body);
  try { await move(temporary, recordPath); }
  finally { await remove(temporary, { force: true }); }
}
