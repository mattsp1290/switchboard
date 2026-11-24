import assert from 'node:assert/strict';
import test from 'node:test';
import { hostImagesRequested, parseHostImages, hostImageLimits } from '../../src/core/image-input.ts';
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
    ...['', 'YQ=', 'YR==', 'YWJ=', 'Y Q==', 'YQ===', '====', 'YR=\n', 'YQ==\r\n', 'YQ==\u2028'].map((s) => [{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${s}` }]),
    [{ mediaType: 'image/png', dataUrl: 'data:image/jpeg;base64,YQ==' }],
    [image(Buffer.from('x'), 'image/gif')]]) assert.equal(parseHostImages(value).kind, 'error');
  for (const s of ['YQ==', 'YWI=', 'YWJj']) assert.equal(parseHostImages([{ mediaType: 'image/png', dataUrl: `data:image/png;base64,${s}` }]).kind, 'ok');
});

test('throwing image input accessors are refused at the validation boundary', () => {
  const input = { get mediaType() { throw new Error('untrusted'); } };
  assert.equal(parseHostImages([input]).kind, 'error');
});

test('image count and contents come from one indexed snapshot', () => {
  const one = image(Buffer.from('x'));
  const forged = [one];
  forged[Symbol.iterator] = function* () { for (let i = 0; i < 17; i++) yield one; };
  assert.equal(parseHostImages(forged).value.length, 1);
  const erased = [one]; erased[Symbol.iterator] = function* () {};
  assert.equal(parseHostImages(erased).value.length, 1);
  const mutated = [one];
  Object.defineProperty(mutated, '0', { get() { mutated.length = 0; return one; } });
  assert.equal(parseHostImages(mutated).kind, 'error');
  let reads = 0;
  const captured = parseHostImages([{ get mediaType() { reads++; return 'image/png'; }, dataUrl: one.dataUrl }]);
  assert.equal(captured.kind, 'ok'); assert.equal(reads, 1);
});

test('custom limits narrow the shared policy without admitting other media types', () => {
  assert.equal(parseHostImages([image(Buffer.from('x'), 'image/gif')], { maxBytes: 99999999, maxImages: 999, mediaTypes: ['image/gif'] }).kind, 'error');
  assert.equal(parseHostImages(Array(17).fill(image(Buffer.from('x'))), { maxBytes: 99999999, maxImages: 999, mediaTypes: ['image/png'] }).kind, 'error');
  assert.equal(parseHostImages([image(Buffer.from('xx'))], { maxBytes: 1, maxImages: 1, mediaTypes: ['image/png'] }).kind, 'error');
});

test('a proxied array cannot hide media by reporting zero length', () => {
 const hidden=new Proxy([{mediaType:'image/png',dataUrl:'data:image/png;base64,YQ=='}],{get(target,key){return key==='length'?0:Reflect.get(target,key);}});
 assert.equal(parseHostImages(hidden).kind,'error');
});


test('image presence handles throwing and revoked proxies without inspection', () => {
  const proxy = new Proxy([], { get() { throw new Error('media canary'); } });
  const revoked = Proxy.revocable([], {}); revoked.revoke();
  assert.equal(hostImagesRequested(proxy), true); assert.equal(hostImagesRequested(revoked.proxy), true);
});
