import test from 'node:test';
import assert from 'node:assert/strict';
import { encodingFromDataspace, decodeNv21, roiMetrics } from '../tools/tuning/color.mjs';

test('JFIF full range and limited BT601 preserve distinct black/white code points', () => {
  const full = encodingFromDataspace(146931712), limited = encodingFromDataspace(281149440);
  assert.equal(full.range, 'full'); assert.equal(limited.range, 'limited');
  assert.deepEqual([...decodeNv21(Uint8Array.from([0, 255, 16, 235, 128, 128]), 2, 2, full)], [0,0,0,255,255,255,16,16,16,235,235,235]);
  assert.deepEqual([...decodeNv21(Uint8Array.from([16,235,16,235,128,128]),2,2,limited)].slice(0,6), [0,0,0,255,255,255]);
  assert.throws(() => encodingFromDataspace(0), /Unsupported/);
});
test('NV21 uses V then U; swapping them cannot masquerade as the same red patch', () => {
  const pixels = Uint8Array.from([76,76,76,76,255,85]), e = { matrix:'BT601', range:'full' };
  const red = decodeNv21(pixels,2,2,e), swapped = decodeNv21(pixels,2,2,e,true);
  assert.ok(red[0] >= 250 && red[1] < 5 && red[2] < 5);
  assert.ok(swapped[2] >= 250 && swapped[0] < 30);
  assert.throws(() => decodeNv21(pixels,3,2,e), /Invalid/);
});
test('neutral ROI metric rejects clipping, darkness and malformed observations', () => {
  const gray = new Uint8Array(16*16*3).fill(128);
  assert.equal(roiMetrics(gray,16,16,[0,0,1,1]).neutral_error, 0);
  assert.equal(roiMetrics(gray,16,16,[0,0,1,1]).usable, true);
  assert.equal(roiMetrics(new Uint8Array(gray.length).fill(255),16,16,[0,0,1,1]).usable, false);
  assert.equal(roiMetrics(new Uint8Array(gray.length).fill(5),16,16,[0,0,1,1]).usable, false);
  assert.throws(() => roiMetrics(gray,16,16,[-1,0,1,1]), /ROI/);
});
