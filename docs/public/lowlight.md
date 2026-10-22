# Static lowlight comparison

Version 0.4.0 adds `nr_sequence` and `evaluate_nr` (13 MCP tools total). A lit-office hardware run has now captured all 326 matched samples with verified controls, consecutive manual-case frames and AUTO/session restoration. Its quality remains diagnostic because baseline noise was not repeatable; lowlight quality and motion behavior are pending. Earlier three-frame NR control tests do not validate this extension.

Version 0.4.3 fixes lowlight AUTO sampling: `nr_sequence` accepts AE `FLASH_REQUIRED` as well as `CONVERGED`, while requiring AWB `CONVERGED` and keeping flash OFF. Android defines `FLASH_REQUIRED` as converged exposure that still needs flash for adequate brightness; it must not be mistaken for ongoing AE search. The WB suite and manual-control/quality gates are unchanged. Two subsequent lowlight runs captured all 326 matched samples each, with verified fixed controls, consecutive manual-case sampling and AUTO/session restoration, but remained diagnostic because brightness stability/comparability failed. No NR winner or profile was installed. See [Android 3A states](https://source.android.com/docs/core/camera/camera3_3Amodes).

## Capture and evaluate

1. Keep the camera and scene still under the lighting to be evaluated.
2. Call `build_camera_probe`, reusing the device's existing local development signing key.
3. Call `run_camera_validation(suite="nr_sequence")` and poll `get_job`.
4. Call `evaluate_nr(run_id=..., roi=[left,top,right,bottom])` on the same static region across cases.

The suite obtains converged AUTO exposure/ISO and WB/CCM under the current lighting, then freezes them. It requests AF/EDGE/FLASH OFF and FAST tone. Standard NR 0/1 × vendor 3DNR 0/1 produces four manual cases, followed by baseline 0/0 return. Each manual case settles for 32 capture results and saves 64 matched NV21/result samples. AUTO and AUTO return each save three matched results, for 326 total samples. Only first-frame JPEGs are saved for viewing; temporal measurements use NV21.

One case is buffered before disk writes to reduce capture interference. Frame numbers/timestamps expose gaps; continuous delivery and sustained FPS are not promised. The current bounded probe rejects AUTO frame duration over 500 ms or gains outside [1,3]. Very dark scenes may also fail AE/AWB convergence. Errors are recorded rather than silently changing the baseline. Other vendor processing may remain; 0/0 is not a full ISP bypass.

Evaluation reports per-pixel temporal Y sample deviation, frame-mean drift, clipping, a gradient proxy from the temporal mean, missing frame numbers and baseline return. It gates fixed-setting readback, useful signal, brightness consistency, sampling and AUTO/session restoration. `STATIC_COMPARISON_READY_FOR_REVIEW` requires human scene/detail review and does not install a profile or choose a winning mode. Otherwise results remain `DIAGNOSTIC_ONLY`. Processed-Y statistics are not RAW sensor SNR, calibrated lux or proof about moving-object ghosting.

## Optional Windows one-shot scheduling

Use existing local Node 22, Android SDK/JDK and development keystore paths. A model API key is not required.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/lowlight/schedule.ps1 `
  -At '2026-10-22T21:00:00+08:00' `
  -Node C:/tools/node/node.exe -Serial YOUR_DEVICE_SERIAL `
  -DevelopmentKeystore C:/private/development.keystore `
  -Roi '.45,.65,.60,.80'
```

Pass `-SdkRoot` and `-JdkRoot` if needed. Version 0.4.2 forwards `-Roi` through the scheduler and PowerShell launcher and records it in the schedule; choose a static unclipped region from your own preview before capture. Coordinates in this example are scene-specific. The date must be in the future; this is an example, not an enabled schedule shipped with the repository. The task runs as the current logged-in Windows user with limited privileges and a hidden PowerShell launcher. It checks ADB first. Disconnected devices produce `NOT_RUN_DEVICE_UNAVAILABLE`; starts more than 15 minutes late produce `NOT_RUN_OUTSIDE_SCHEDULE_WINDOW`. There is no recurring retry. The task can request wake from sleep, but the PC must remain available with that Windows session and the board connected.

Results/logs/schedule records stay under `outputs/lowlight-jobs`, `outputs/lowlight-launches` and `outputs/lowlight-schedules`. Preserve those logs when diagnosing a failed launch. A successful job points to the run's `lowlight/comparison.html`; source hashes and capture provenance accompany the evidence. Cancel a pending run by removing only its named `Genio-lowlight-<date>-<time>` task from Windows Task Scheduler.
