"""Deterministic RAW inspection. No denoise, sharpening, deconvolution or AI reconstruction."""
import argparse
import hashlib
import json
from pathlib import Path
import platform

import cv2
import numpy as np
from PIL import Image
import rawpy


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def srgb(linear):
    a = np.clip(linear, 0, 1)
    return np.where(a <= .0031308, 12.92*a, 1.055*np.power(a, 1/2.4)-.055)


def matrix(values):
    return np.array([n/d for n, d in values], np.float32).reshape(3, 3)


def develop(mosaic, black, white, gains, ccm):
    # Explicit RGGB pattern, not the short OpenCV Bayer aliases.
    linear = np.empty(mosaic.shape, np.float32)
    for (y, x), pedestal, gain in zip([(0, 0), (0, 1), (1, 0), (1, 1)], black, gains):
        linear[y::2, x::2] = np.maximum(mosaic[y::2, x::2].astype(np.float32)-pedestal, 0)/(white-pedestal)*gain
    bayer16 = np.rint(np.clip(linear, 0, 1)*65535).astype(np.uint16)
    rgb = cv2.cvtColor(bayer16, cv2.COLOR_BayerRGGB2RGB).astype(np.float32)/65535
    output = np.einsum('...c,dc->...d', rgb, ccm)
    return np.rint(srgb(output)*255).astype(np.uint8)


def write_rgb(path, rgb):
    Image.fromarray(rgb).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('directory', type=Path)
    args = ap.parse_args()
    root = args.directory.resolve()
    report = json.loads((root/'report.json').read_text(encoding='utf-8-sig'))
    raw = report['raw']
    if report['suite'] != 'raw' or report['status'] != 'PASS' or not report['raw_yuv_timestamps_match']:
        raise ValueError('A successful timestamp-matched RAW run is required')
    c, r = report['inventory']['characteristics'], report['raw_result']
    if c['android.sensor.info.colorFilterArrangement'] != 0:
        raise ValueError('Only explicitly declared RGGB is supported by this inspection script')
    source = root/raw['raw16']
    if source.parent != root or source.stat().st_size != raw['width']*raw['height']*2:
        raise ValueError('Unexpected RAW16 source path/size')
    mosaic = np.fromfile(source, dtype='<u2').reshape(raw['height'], raw['width'])
    black = c['android.sensor.blackLevelPattern']
    white = c['android.sensor.info.whiteLevel']
    gains = r['android.colorCorrection.gains']
    ccm = matrix(r['android.colorCorrection.transform'])
    out = root/'developed'
    out.mkdir(exist_ok=True)
    # Detect an accidental OpenCV Bayer/channel convention change with a synthetic known color.
    probe = np.zeros((8, 8), np.uint16)
    probe[0::2, 0::2], probe[0::2, 1::2], probe[1::2, 0::2], probe[1::2, 1::2] = 800, 200, 200, 50
    np.testing.assert_array_equal(cv2.cvtColor(probe, cv2.COLOR_BayerRGGB2RGB)[3, 3], [800, 200, 50])
    own = develop(mosaic, black, white, gains, ccm)
    write_rgb(out/'bilinear-no-nr-no-sharpen.png', own)
    thumb = Image.fromarray(own)
    thumb.thumbnail((1280, 1280))
    thumb.save(out/'overview.jpg', quality=95)
    # Original sampled green planes: no demosaic, WB, CCM or spatial filtering.
    for name, y, x, pedestal in [('green-even', 0, 1, black[1]), ('green-odd', 1, 0, black[2])]:
        green = np.maximum(mosaic[y::2, x::2].astype(np.float32)-pedestal, 0)/(white-pedestal)
        Image.fromarray(np.rint(srgb(green)*255).astype(np.uint8)).save(out/(name+'.png'))
    with rawpy.imread(str(root/raw['dng'])) as dng:
        visible = dng.raw_image_visible.copy()
        equal = visible.shape == mosaic.shape and np.array_equal(visible, mosaic)
        libraw = dng.postprocess(use_camera_wb=True, use_auto_wb=False, no_auto_bright=True,
            demosaic_algorithm=rawpy.DemosaicAlgorithm.LINEAR, output_color=rawpy.ColorSpace.sRGB,
            output_bps=8, gamma=(2.4, 12.92), bright=1, median_filter_passes=0,
            fbdd_noise_reduction=rawpy.FBDDNoiseReductionMode.Off, noise_thr=0, user_flip=0)
    write_rgb(out/'libraw-linear-no-nr-no-sharpen.png', libraw)
    analysis = {'schema_version': 1, 'run_id': report['run_id'], 'host': platform.node(),
        'python': platform.python_version(), 'opencv': cv2.__version__, 'numpy': np.__version__,
        'rawpy': rawpy.__version__, 'libraw': rawpy.libraw_version,
        'raw16_sha256': sha256(source), 'dng_sha256': sha256(root/raw['dng']),
        'report_sha256': sha256(root/'report.json'), 'script_sha256': sha256(__file__),
        'shape': list(mosaic.shape), 'cfa': 'RGGB', 'black': black, 'white': white,
        'wb_gains': gains, 'ccm': ccm.tolist(), 'libraw_visible_equals_raw16': equal,
        'sample_min': int(mosaic.min()), 'sample_max': int(mosaic.max()),
        'processing': 'Black subtraction/normalization, captured WB, bilinear demosaic, captured CCM, sRGB transfer. No LSC applied in the custom branch; no NR/sharpen/deconvolution in either branch.',
        'green_planes': 'Every second row/column from the original Bayer samples, black-corrected and sRGB-encoded for viewing only. No interpolation or color matrix.',
        'limitations': ['RAW_SENSOR is the HAL output, not proof of an uncorrected MIPI tap.',
            'LibRaw uses DNG calibration; its color rendering can differ from the captured Camera2 matrix.',
            'Blur in sampled Bayer planes precedes YUV processing but does not identify optics versus sensor, motion or RAW-stage processing.',
            'The paired HAL YUV is only 640x480; any upscaling must be labeled and is not added detail.']}
    (out/'report.json').write_text(json.dumps(analysis, indent=2), encoding='utf-8')
    print(json.dumps({'output': str(out), 'raw_shape': list(mosaic.shape), 'dng_equals_raw16': equal}))


if __name__ == '__main__':
    main()
