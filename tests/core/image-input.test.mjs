import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHostImages, hostImageLimits } from '../../src/core/image-input.ts';
const image = (bytes, mediaType = 'image/png') => ({ mediaType, dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}` });
test('image parser accepts exact aggregate boundary, copies and freezes output', () => {
  const input = [image(Buffer.alloc(2097152)), image(Buffer.alloc(2097152), 'image/jpeg')];
  const result = parseHostImages(input);
  assert.equal(result.kind, 'ok');
  assert.equal(result.value.reduce((sum, i) => sum + i.bytes, 0), hostImageLimits.maxBytes);
  input[0].dataUrl = 'changed';
  assert.equal(result.value[0].base64.length, 2796204);
  assert(Object.isFrozen(result.value) && Object.isFrozen(result.value[0]));
  assert.deepEqual(parseHostImages([]), { kind: 'ok', value: [] });
});
test('image parser refuses malformed, noncanonical and excessive input', () => {
  for (const value of [null, {}, 'image', [null], [image(Buffer.alloc(4194305))],
    [image(Buffer.alloc(4194304)), image(Buffer.from('x'))], Array(17).fill(image(Buffer.from('x'))),
    ...['', 'YQ=', 'YR==', 'YWJ=', 'Y Q==', 'YQ===', '===='].map((s) => [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${s}` }]),
    [{ mediaType: 'image/png', dataUrl: 'data:image/jpeg;base64,YQ==' }],
    [image(Buffer.from('x'), 'image/gif')]]) assert.equal(parseHostImages(value).kind, 'error');
  for (const s of ['YQ==', 'YWI=', 'YWJj']) assert.equal(parseHostImages([{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${s}` }]).kind, 'ok');
});
