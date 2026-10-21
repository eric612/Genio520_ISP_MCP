// RGB code values for a fixed rendering pipeline; these are not scene-linear colorimetry.
export function encodingFromDataspace(dataspace) {
  if (!Number.isInteger(dataspace)) throw new Error('Image dataspace is required');
  const standard = (dataspace >>> 16) & 63, transfer = (dataspace >>> 22) & 31, range = (dataspace >>> 27) & 7;
  if (![1, 2, 4].includes(standard) || ![1, 2].includes(range) || ![2, 3].includes(transfer))
    throw new Error(`Unsupported or unknown YUV dataspace: ${dataspace}`);
  return { matrix: standard === 1 ? 'BT709' : 'BT601', range: range === 1 ? 'full' : 'limited', transfer };
}
export function decodeNv21(data, width, height, encoding, swapUV = false) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width % 2 || height % 2
      || data.length !== width * height * 3 / 2) throw new Error('Invalid NV21 dimensions or size');
  if (!['BT601', 'BT709'].includes(encoding.matrix) || !['full', 'limited'].includes(encoding.range)) throw new Error('Unknown YUV encoding');
  const kr = encoding.matrix === 'BT601' ? .299 : .2126, kb = encoding.matrix === 'BT601' ? .114 : .0722, kg = 1 - kr - kb;
  const rgb = new Uint8Array(width * height * 3), clip = v => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, uv = width * height + (y >> 1) * width + (x & ~1);
    const yy = encoding.range === 'full' ? data[i] : (data[i] - 16) * 255 / 219;
    const scale = encoding.range === 'full' ? 1 : 255 / 224;
    const v = (data[uv + (swapUV ? 1 : 0)] - 128) * scale, u = (data[uv + (swapUV ? 0 : 1)] - 128) * scale;
    rgb[3 * i] = clip(yy + 2 * (1 - kr) * v);
    rgb[3 * i + 1] = clip(yy - 2 * kb * (1 - kb) / kg * u - 2 * kr * (1 - kr) / kg * v);
    rgb[3 * i + 2] = clip(yy + 2 * (1 - kb) * u);
  }
  return rgb;
}
export function roiMetrics(rgb, width, height, roi) {
  if (!Array.isArray(roi) || roi.length !== 4 || roi.some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || roi[0] >= roi[2] || roi[1] >= roi[3]) throw new Error('ROI must be normalized [left,top,right,bottom]');
  if (rgb.length !== width * height * 3) throw new Error('Invalid RGB size');
  const sums = [0, 0, 0]; let count = 0, clipped = 0;
  for (let y = Math.floor(roi[1] * height); y < Math.ceil(roi[3] * height); y++)
    for (let x = Math.floor(roi[0] * width); x < Math.ceil(roi[2] * width); x++) {
      const p = 3 * (y * width + x), pixel = rgb.subarray(p, p + 3);
      if (Math.min(...pixel) <= 2 || Math.max(...pixel) >= 253) clipped++;
      for (let c = 0; c < 3; c++) sums[c] += pixel[c]; count++;
    }
  if (count < 64) throw new Error('ROI is too small');
  const mean = sums.map(s => s / count), brightness = mean.reduce((a, b) => a + b) / 3;
  const rg = mean[0] / Math.max(1, mean[1]), bg = mean[2] / Math.max(1, mean[1]);
  return { rgb_mean: mean, rg, bg, neutral_error: Math.max(Math.abs(Math.log(Math.max(rg, 1e-6))), Math.abs(Math.log(Math.max(bg, 1e-6)))),
    brightness, clipped_fraction: clipped / count, pixels: count, usable: brightness >= 32 && brightness <= 220 && clipped / count < .01 };
}
