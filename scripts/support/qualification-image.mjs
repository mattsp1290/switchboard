import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}
/** Valid 64×64 RGBA PNG, padded with a valid ancillary tEXt chunk to exactly 4 MiB. */
export function qualificationImage() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(64 * (64 * 4 + 1));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const at = y * 257 + 1 + x * 4;
    pixels[at + (x < 32 ? 0 : 2)] = 255; pixels[at + 3] = 255;
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk('IHDR', header);
  const idat = chunk('IDAT', deflateSync(pixels));
  const end = chunk('IEND', Buffer.alloc(0));
  const padding = Buffer.alloc(4194304 - signature.length - ihdr.length - idat.length - end.length - 12, 120);
  padding.write('padding\0');
  return Buffer.concat([signature, ihdr, idat, chunk('tEXt', padding), end]);
}
