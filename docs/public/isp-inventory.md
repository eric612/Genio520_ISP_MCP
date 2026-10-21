# ISP inventory and RAW capture

Status: verified through a real MCP client on 2026-10-21 using Genio 520/MT8371, Android 15/API 35 and an IMX258 RAW camera. Inventory, timestamp-matched RAW/YUV with DNG, the original controls regression and the independent NR-control matrix passed. This does not establish arbitrary internal P1 buffer export, complete RAW bypass, sustained frame rate or noise-reduction quality. Device images and reports stay local.

Use the existing `run_camera_validation` MCP tool with one of the following suites, after `build_camera_probe`:

| Suite | Purpose |
| --- | --- |
| `inventory` | Camera characteristics, actual request/result/session keys, output dimensions and durations, preview/still/video template defaults. Opens the camera to inspect templates; does not request image frames. |
| `raw` | Warm up using YUV, then request a single RAW_SENSOR plus YUV capture. Save packed-row uint16 RAW16, an optional DNG, full available result metadata and timestamp-matched YUV. |
| `controls` | Existing 7-case control/readback regression. |
| `nr` | Auto plus standard NR 0/1 × vendor 3DNR 0/1 (5 cases, 15 matched frames). Validates advertised vendor modes and the template's single-int-array type before setting the vendor key. Checks independent readback, without claiming image quality or complete bypass. |

The tool returns a job ID; use `get_job` and `get_report`. A full report includes the inventory and available raw result metadata. Large opaque byte arrays are reported by type and size rather than exported as undocumented binary payloads. DNG conversion status is reported independently: RAW capture can succeed even if mandatory DNG metadata is insufficient.

For a board inventory without camera configuration or changing debug properties:

```powershell
node tools/isp_inventory/collect.mjs
```

For a real MCP client run covering the new suites and the control regression:

```powershell
node tools/isp_inventory/verify.mjs --controls --nr
```

When the installed diagnostic APK uses an existing development key, set `GENIO_CAMERA_KEYSTORE` to that local key before building. See the repository README. No SDK, signing key or camera capture is included here.

`--nr-only` rebuilds the APK and runs only the independent NR-control matrix. Existing MCP clients may need to restart their server to load the new suite enum.

## Observed on this board

- CameraCharacteristics API: 100 exposed keys; 101 actual request keys, 113 advertised result keys and 17 session keys. Different dump/API enumerations can expose different counts.
- Preview/video templates use standard NR, edge, hot-pixel, shading and tone mode 1; the still template uses mode 2. All three templates default the vendor 3DNR request to `int[]{1}`.
- RAW_SENSOR: 4208×3120, row stride 8416, pixel stride 2; tight RAW16 file 26,257,920 bytes. DNG conversion succeeded; its uncompressed 16-bit RGGB Bayer strips matched the RAW16 file byte for byte. RAW image, YUV image and SENSOR_TIMESTAMP matched. Different RAW/YUV sizes do not imply pixel-coordinate alignment.
- A RAW capture actually returned 90 result keys, including a 17×17×4 lens-shading gain map and neutralColorPoint/noiseProfile/greenSplit. The advertised tuning-data, histogram and sharpness-map keys did not provide payloads in this capture.
- The original 7-case/21-frame controls test and the new 5-case/15-frame NR matrix passed. Standard NR OFF can coexist with a vendor 3DNR readback of 1; verify both controls when comparing an additional NR stage.
- The sensor driver reports IMX258 and HDR support 0. This is separate from the SoC ISP's HDR capability. Camera2's photo-HDR vendor declaration does not override either fact.
- On this Android image, `/dev/video0` and `/dev/video1` are video decoder/encoder devices, not camera taps. The existing camera-dump directory was empty; no internal stage dumps were enabled or recovered.

The first inventory attempt exposed an Android Rational serialization bug (`Rational` inherits `Number` but `1/2` is not a valid JSON number). Rational values now serialize as numerator/denominator arrays; all four suites passed after rebuilding.

## Interpreting the results

Track four distinct facts for each feature: advertised, request accepted, result reported and image effect measured. The presence of a vendor tag does not define its legal values or guarantee an effect. Defaults can vary between preview, still and video sessions. RAW/YUV reprocessing capabilities do not expose every internal ISP stage to applications.

In particular:

- Camera2 RAW_SENSOR is 16-bit-per-sample Bayer storage; the effective range, CFA and black/white levels come from metadata. It is not necessarily the sensor's packed MIPI byte layout or a complete bypass of every calibration stage.
- A DNG container preserves RAW interpretation metadata; it is not a demosaiced RGB image.
- Matching RAW, YUV and SENSOR_TIMESTAMP is necessary for a paired capture. A processed YUV image is not a tap at an arbitrary P1 block boundary.
- A P1 log stream label is evidence of configured pipeline activity, not access to its pixel/statistics buffer. Internal RGB, NR-before/after, tone-before/after or LCS/RSS buffers require an explicitly supported HAL/debug interface.
- A standard NR OFF readback is insufficient evidence that every vendor temporal/multiframe path is bypassed. Verify the output and vendor feature controls separately.
- A global tone curve is not multiexposure HDR. MediaTek's [Genio 520 FAQ](https://genio.mediatek.com/zh-tw/genio-520) explicitly states that the G520 ISP does not support HDR; a photo-HDR tag requires separate investigation of its actual processing path.

References: [Camera2 capture controls](https://developer.android.com/reference/android/hardware/camera2/CaptureRequest), [RAW_SENSOR](https://developer.android.com/reference/android/graphics/ImageFormat#RAW_SENSOR), [DngCreator](https://developer.android.com/reference/android/hardware/camera2/DngCreator). MediaTek also documents [sensor RAW direct dump for Yocto](https://genio.mediatek.com/doc/iot-yocto/latest/sw/yocto/app-dev/camera/camera-g720-evk-v4l2-raw.html); those driver/format commands must not be applied blindly to the Android image.
