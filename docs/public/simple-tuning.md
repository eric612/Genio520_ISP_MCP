# Simple tuning and focus inspection

Version 0.3.0 exposes 12 MCP tools. The tuning loop uses a fixed reference, bounded proposals, actual camera probes, measurements, and a return check. Its design draws on [Harness2's propose/probe/compose workflow](https://github.com/google-research/harness2); no Harness2 runtime is installed or required.

## WB through MCP

1. Build with `build_camera_probe`.
2. Run `run_camera_validation(suite="wb")`, then poll `get_job` until completion.
3. Use `evaluate_wb(run_id=..., roi=[left,top,right,bottom], neutral_reference_confirmed=...)` on a physically established neutral reference, in normalized captured-image coordinates.
4. Inspect its measurements, comparison HTML and candidate profile. A second probe can supply `wb_candidates` (1–12 arrays of R/Ge/Go/B) to the same validation tool.

The default probe uses gains inside [1,3]. Optional candidates allow [1,4] as a software probe bound: [Android guarantees only [1,3]](https://developer.android.com/reference/android/hardware/camera2/CaptureRequest#COLOR_CORRECTION_GAINS); values above 3 require device-specific readback verification and are not a claim about other cameras.

Every WB run captures AUTO, a frozen baseline, candidates, baseline return and AUTO return. The baseline's exposure/ISO and CCM remain fixed across manual candidates. It saves three timestamp-matched NV21/JPEG samples per case, requests no flash/table/firmware writes and closes its camera session. An unsuccessful run can have an unverified AUTO-return status; session close is reported separately. No profile is automatically installed or persisted.

Evaluation verifies control readback, ROI usability/clipping, manual/AUTO equivalence, A/A' repeatability and restoration. Without a confirmed neutral reference it returns diagnostics only. It can prefer the original baseline. The metric is rendered RGB R/G and B/G error under fixed tone/CCM, not calibrated ColorChecker deltaE or sensor colorimetry. Lighting, a protective film, physical focus or scene changes invalidate earlier candidates.

CLI equivalents:

```powershell
node tools/isp_inventory/verify.mjs --wb-only --wb-roi=.4,.4,.6,.6 --neutral-confirmed
node tools/isp_inventory/verify.mjs --wb-only --wb-plan=local-plan.json
node tools/tuning/analyze.mjs outputs/camera-runs/RUN_ID --roi=.4,.4,.6,.6
```

Only confirm the reference when a neutral target is actually present in that ROI. Keep images and generated profiles local.

## Original pixels and focus

`suite="jpeg"` saves the largest advertised native HAL JPEG without app YUV re-encoding (3840×2160 on the tested build). Preview `width/height` are separate from `photo_width/photo_height`.

`suite="raw"` saves RAW16/DNG and paired YUV. `still_exposure_ns` optionally fixes RAW/JPEG exposure; ISO is scaled from the auto warmup result and clamped to the advertised range. The actual exposure/ISO are checked in the still result. Other processing settings remain at their template values.

Optional offline RAW inspection:

```bash
python3 tools/tuning/develop_raw.py /path/to/raw-run
```

This script requires NumPy, OpenCV, Pillow and rawpy. It validates the declared RGGB layout, exports sampled green planes without interpolation, and independently develops a bilinear/captured-CCM branch and a LibRaw DNG branch. Neither uses denoise, sharpening, deconvolution or AI reconstruction. Its report records versions, source hashes, capture metadata and whether DNG samples equal RAW16. RAW_SENSOR can already include vendor processing: a soft RAW narrows the problem to before/at RAW output, without identifying optics versus sensor, motion or RAW-stage processing.

## PC live camera preview

Install an official Windows [scrcpy release](https://github.com/Genymobile/scrcpy/releases) separately, preserving its bundled notices. The tested portable version is 5.0.1; its official win64 ZIP SHA256 is `b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5`.

```powershell
powershell -File tools/live_preview/start.ps1 -Scrcpy C:/tools/scrcpy/scrcpy.exe
powershell -File tools/live_preview/stop.ps1
```

The visible camera window uses ADB/Camera2, camera 0, a 1920×1080 / 30 fps request and no audio. This is not a UVC device or a sustained-FPS measurement. Stop preview before a diagnostic capture because it owns the camera; the stop script checks PID, executable and start time before stopping only its own recorded process. Optical/manual focus is separate from the Android AF interface.
