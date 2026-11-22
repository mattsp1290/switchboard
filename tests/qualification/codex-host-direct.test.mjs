import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import { qualificationImage } from '../../scripts/support/qualification-image.mjs';

test('direct qualification stays inert without its explicit gate', () => {
  const env = { ...process.env }; delete env.SWITCHBOARD_QUALIFY_CODEX_HOST;
  const result = spawnSync(process.execPath, ['scripts/qualify-codex-host-direct.mjs'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Skipped:/);
  assert.equal(result.stderr, '');
});
test('native qualification attachment is an exact 4 MiB valid PNG', () => {
  const png = qualificationImage();
  assert.equal(png.length, 4194304);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    chunks.push(type);
    const bytes = png.subarray(at + 4, at + 8 + length);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal(png.readUInt32BE(at + 8 + length), (crc ^ 0xffffffff) >>> 0, `${type} CRC`);
    if (type === 'IHDR') { assert.equal(png.readUInt32BE(at + 8), 64); assert.equal(png.readUInt32BE(at + 12), 64); }
    if (type === 'IDAT') assert.equal(inflateSync(png.subarray(at + 8, at + 8 + length)).length, 64 * 257);
    at += length + 12;
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'tEXt', 'IEND']);
});
