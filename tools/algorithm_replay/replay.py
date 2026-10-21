"""Run the external, hash-pinned visual ISP on real NV21 captures; no model training or source edits."""
import argparse
import hashlib
import importlib
import inspect
import json
import platform
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
import cv2
import numpy as np
from nv21 import decode, encode


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def plain(value):
    return json.loads(json.dumps(value, default=lambda v: v.item() if isinstance(v, np.generic) else list(v)))


def restore_stage(cls, recorded):
    signature = inspect.signature(cls)
    kwargs = {name: value for name, value in recorded.items() if name in signature.parameters}
    if '_GAIN_Q' in recorded and 'gain_q' in signature.parameters:
        kwargs['gain_q'] = recorded['_GAIN_Q']
    stage = cls(**kwargs)
    mismatches = {}
    for key, value in recorded.items():
        if key == '__class__':
            continue
        if not hasattr(stage, key) or plain(getattr(stage, key)) != value:
            mismatches[key] = {'expected': value, 'actual': plain(getattr(stage, key, None))}
    if mismatches:
        raise ValueError('Sidecar attribute restoration mismatch: ' + json.dumps(mismatches))
    extra = {key: default.default for key, default in signature.parameters.items()
             if key not in recorded and key != 'gain_q' and default.default is not inspect.Parameter.empty}
    return stage, {'class': cls.__name__, 'constructor': plain(kwargs),
                   'additional_current_source_defaults_not_in_historical_sidecar': plain(extra)}


def engine(recipe):
    module = importlib.import_module('img_enhance.enhance')
    module = importlib.reload(module)  # Sequence boundary: reset every temporal object, including globals.
    if recipe['wdr']['__class__'] != 'EnvelopeWDR' or recipe['defog']['__class__'] != 'DarkChannelDefog':
        raise ValueError('Unsupported external stage family')
    module._isp_wdr, wdr = restore_stage(module.EnvelopeWDR, recipe['wdr'])
    module._isp_defog, defog = restore_stage(module.DarkChannelDefog, recipe['defog'])
    if recipe['luma_backend'] != '<lambda>' or recipe['chroma_backend'] != '<lambda>':
        raise ValueError('Both historical full-frame NR backends must be explicit passthrough')
    module.set_isp_luma_backend(lambda y: y)
    module.set_isp_chroma_backend(lambda c, y: c)
    module._isp_defog_strength = 0.0
    module._isp_defog_dc_src = recipe['defog_dc_src']
    module._isp_wdr_gain_src = recipe['wdr_gain_src']
    module._isp_chroma_couple = recipe['chroma_couple']
    module._isp_local_contrast = recipe['local_contrast']
    # The legacy sidecar did not include these: pin the current-source choice and disclose it.
    module._isp_chroma_mode = 'couple'
    module._isp_shadow_tint = 'off'
    settings = {key: plain(getattr(module, key)) for key in [
        '_isp_defog_strength', '_isp_defog_dc_src', '_isp_wdr_gain_src', '_isp_chroma_couple',
        '_isp_local_contrast', '_isp_chroma_mode', '_isp_shadow_tint', '_isp_chroma_budget',
        '_CHROMA_FACTOR', '_ISP_CHROMA_SAT_MAX']}
    return module.enhance_isp, {'wdr': wdr, 'defog': defog, 'pipeline': settings,
                              'luma_nr': 'passthrough', 'chroma_nr': 'passthrough',
                              'override_from_artifact': {'defog_strength': [recipe['defog_strength'], 0.0]}}


def difference(expected, actual):
    if expected.shape != actual.shape or expected.dtype != actual.dtype:
        raise ValueError('Comparison shape/dtype mismatch')
    error = actual.astype(np.float64) - expected.astype(np.float64)
    absolute = np.abs(error)
    return {'shape': list(actual.shape), 'dtype': str(actual.dtype),
            'input_min': int(expected.min()), 'input_max': int(expected.max()),
            'output_min': int(actual.min()), 'output_max': int(actual.max()),
            'mae': float(absolute.mean()), 'rmse': float(np.sqrt((error*error).mean())),
            'max_abs_error': int(absolute.max()), 'mismatch_count': int(np.count_nonzero(absolute)),
            'worst_location': [int(i) for i in np.unravel_index(absolute.argmax(), absolute.shape)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle')
    args = parser.parse_args()
    root = Path(args.bundle).resolve()
    manifest = json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('encoding', {}).get('matrix') != 'BT601' or manifest['encoding']['range'] != 'full':
        raise ValueError('Only verified BT601 full-range input is supported')
    verified = set()
    for record in manifest['files']:
        file = (root/record['path']).resolve()
        if root not in file.parents or file.stat().st_size != record['bytes'] or sha(file) != record['sha256']:
            raise ValueError('Private snapshot/input hash mismatch: ' + record['path'])
        verified.add(record['path'])
    for frame in manifest['frames']:
        if frame['file'] not in verified or frame['node_bgr'] not in verified:
            raise ValueError('Frame input must be part of the verified snapshot')
    sys.path.insert(0, str(root/'source'))
    imported = importlib.import_module('img_enhance.enhance')
    if not Path(imported.__file__).resolve().is_relative_to(root/'source'):
        raise ValueError('Imported the wrong external source tree')
    cv2.setNumThreads(1)
    recipe = json.loads((root/'reference.provenance.json').read_text(encoding='utf-8'))
    apply, settings = engine(recipe)
    output = root/'reference'
    output.mkdir()  # Refuse to replace a prior result.
    width, height = manifest['width'], manifest['height']
    rows = []
    for i, frame in enumerate(manifest['frames']):
        data = (root/frame['file']).read_bytes()
        bgr = decode(data, width, height)
        node_bgr = np.frombuffer((root/frame['node_bgr']).read_bytes(), np.uint8).reshape(height, width, 3)
        decoder_check = difference(node_bgr, bgr)
        if decoder_check['max_abs_error'] != 0:
            raise ValueError('Python input decoder differs from independent Node decoder: ' + json.dumps(decoder_check))
        converted = encode(bgr)
        before = time.perf_counter_ns()
        enhanced = apply(bgr.copy())
        elapsed = (time.perf_counter_ns()-before)/1e6
        if enhanced.dtype != np.uint8 or enhanced.shape != bgr.shape:
            raise ValueError('External visual ISP output must retain BGR uint8 shape')
        processed = encode(enhanced)
        results = {'identity': (data, bgr), 'conversion_control': (converted, bgr), 'wdr': (processed, enhanced)}
        artifacts = {}
        for name, (nv21, native_bgr) in results.items():
            folder = output/name
            folder.mkdir(exist_ok=True)
            filename = f'frame-{i:04d}'
            (folder/(filename+'.nv21')).write_bytes(nv21)
            preview = decode(nv21, width, height)
            if not cv2.imwrite(str(folder/(filename+'.png')), preview):
                raise IOError('Cannot save native-size preview')
            if name == 'wdr':
                native_bgr.tofile(folder/(filename+'.bgr'))
                cv2.imwrite(str(folder/(filename+'-before-nv21-encoding.png')), native_bgr)
            artifacts[name] = {'nv21': f'{name}/{filename}.nv21', 'png': f'{name}/{filename}.png',
                               'nv21_sha256': sha(folder/(filename+'.nv21')),
                               'adapter_roundtrip_bgr_error': difference(native_bgr, preview)}
        rows.append({'index': i, 'sensor_timestamp_ns': frame['metadata']['sensor_timestamp_ns'],
                     'identity_nv21_exact': data == results['identity'][0],
                     'independent_node_python_decoder': decoder_check,
                     'wdr_reference_bgr_sha256': hashlib.sha256(enhanced.tobytes()).hexdigest(),
                     'effect_bgr_difference_not_quality_score': difference(bgr, enhanced),
                     'input_pixels_any_channel_ge253_fraction': float(np.mean(np.max(bgr, axis=2) >= 253)),
                     'wdr_pixels_any_channel_ge253_fraction': float(np.mean(np.max(enhanced, axis=2) >= 253)),
                     'algorithm_host_ms_including_internal_ycrcb_and_coupling': elapsed,
                     'artifacts': artifacts})
    repeat, repeat_settings = engine(recipe)
    for i, frame in enumerate(manifest['frames']):
        again = repeat(decode((root/frame['file']).read_bytes(), width, height))
        if hashlib.sha256(again.tobytes()).hexdigest() != rows[i]['wdr_reference_bgr_sha256']:
            raise ValueError('Pipeline replay was not deterministic after sequence reset')
    if repeat_settings != settings:
        raise ValueError('Effective settings changed during reset')
    analysis = {'schema_version': 1, 'status': 'OFFLINE_REFERENCE_REPLAY_PASS',
                'run_id': manifest['run_id'], 'case_name': manifest['case_name'],
                'host': platform.node(), 'python': platform.python_version(), 'opencv': cv2.__version__, 'numpy': np.__version__,
                'manifest_sha256': sha(root/'manifest.json'), 'reference_artifact': manifest['reference_artifact'],
                'effective_settings': settings, 'frames': rows, 'reset_replay_bgr_exact': True,
                'limitations': manifest['limitations'] + [
                    'WDR-only ablation of the recorded visual pipeline: defog is explicitly disabled; no quality approval is claimed.',
                    'Full-frame luma/chroma NR are both passthrough in this arm. Upstream MTK processing is already in the captured pixels.',
                    'Only the real captured frames are replayed, from cold state. Three samples cannot validate temporal quality.',
                    'Timing is host Python observation, not Android performance; no warmup or sustained benchmark claim.',
                    'NV21 output re-encodes chroma with aligned 2x2 averaging; adapter loss is reported separately.',
                    'No Android native algorithm execution or TTC acceptance test was performed.']}
    (output/'report.json').write_text(json.dumps(analysis, indent=2), encoding='utf-8')
    sections = []
    for i in range(len(rows)):
        cards = []
        for name, title in [('identity', 'Captured NV21'), ('conversion_control', 'Conversion control'), ('wdr', 'WDR + chroma coupling')]:
            cards.append(f'<article><h2>Frame {i}: {title}</h2><img src="{name}/frame-{i:04d}.png"></article>')
        cards.append('<article><h2>Interpretation</h2><p>The conversion control changes only the adapter. '
                     'WDR uses the same input and retains chroma coupling. Defog and both full-frame NR stages are passthrough in this arm. '
                     'Brightening is visible but is not proof of recovered clipped highlights or improved quality.</p></article>')
        sections.append('<section>' + ''.join(cards) + '</section>')
    (output/'comparison.html').write_text(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
        '<title>Offline WDR integration reference</title><style>body{font:16px system-ui;background:#15202b;color:#eee;margin:24px}'
        'section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:1320px}article{padding:10px;background:#233444}'
        'img{width:100%;height:auto}h2{font-size:17px}p{max-width:1000px;line-height:1.6}</style>'
        '<h1>Offline WDR integration reference</h1><p>Historical artifact configuration, WDR-only ablation; '
        'current-source defaults are disclosed. Full-frame luma/chroma NR passthrough. '
        'No current-product approval, haze removal, TTC improvement or Android performance claim.</p>'
        '<p>All previews are decoded from the saved output NV21, at the original capture resolution. '
        'Conversion control isolates adapter rounding/chroma resampling. Report MAE means change, not improvement.</p>'
        ''.join(sections) + '<p><a href="report.json">Provenance and numerical report</a></p>', encoding='utf-8')
    print(json.dumps({'status': analysis['status'], 'output': str(output), 'frames': len(rows), 'reset_replay_bgr_exact': True}))


if __name__ == '__main__':
    main()
