# Validation status — 2026-10-21

Version 0.3.0 provides a generic MCP bridge with 12 tools, including WB evaluation. Standard Node.js 22 and the MCP SDK are the only server runtime requirements; camera operations additionally use locally installed Android/JDK tools. Python RAW inspection and scrcpy preview are optional. No indexer, vendor BSP, shared model key or board credentials are included.

Verified locally:

- Fresh source export installed all 95 locked package instances with `npm ci --ignore-scripts`.
- Eight tests passed, including real stdio and Streamable HTTP MCP clients performing source read, SHA256-checked edit, Git diff and selective commit in isolated workspaces.
- Negative tests cover stale edits, ambiguous replacements, existing-file creation, private/generated paths, Windows reserved paths, junctions/hardlinks, invalid HTTP credentials, Host and Origin.
- The independent source checkout built and deployed a Camera2 APK through MCP on a Genio 520 running Android 15/API 35.
- All 7 control cases passed, with 3 timestamp-matched YUV/result frames per case (21 total). Exposure, ISO, NR/tone modes and requested three-channel tone curves passed the implemented readback checks.

The subsequent ISP-inventory extension was also verified locally on the same board: 100 characteristics, 101 request keys, 113 advertised result keys and 17 session keys; 4208×3120 RAW16 plus DNG and timestamp-matched YUV; a 17×17 lens-shading map; and a 5-case/15-frame standard NR/vendor 3DNR control matrix. The original control regression and eight local tests passed again after the extension. These are control/data-access results, not noise-reduction quality or arbitrary internal-stage dump results. See [ISP inventory](isp-inventory.md).

The board already had the diagnostic application installed. Its existing local development keystore was explicitly reused for the update; no signing key is shipped with this repository. Captures, APKs and raw board reports remain local and are not repository content.

The tested source checkout is a new Git history. Internal project documents, official photographs, private MCP settings and SDK binaries are excluded.

Browser account connections, public OAuth hosting, multi-user device isolation and sustained ISP performance are not part of this generic MCP acceptance. Browser-specific setup remains a separate optional step. This bridge does not include WDR/Defog/TNR algorithm implementations.

The simple-tuning extension passed 13 local tests (including real stdio/HTTP clients, color-range/UV fixtures and rejection of recommendations without reference, restoration or repeatability). Board WB default/custom probes passed 13 cases/39 matched frames; native JPEG 3840×2160 and manual 8 ms RAW/ISO readback also passed. The inventory/RAW/7-case controls/NR matrix regression passed after the camera changes.

The user then identified and removed a blue protective film. All film-on WB profiles were superseded. A film-off WB run was correctly left diagnostic-only when its A/A' brightness check failed. Before mechanical focus adjustment, RAW and independently sampled Bayer green planes showed soft detail at both approximately 20 ms and 8 ms. After the user adjusted focus, a fresh RAW showed visibly improved facial, radial-pattern and surface detail in development and non-interpolated green samples. The framing changed, so this is qualitative evidence supporting a focus contribution, not an MTF calibration. Preview was stopped as requested.

Post-focus WB was rebuilt and verified through coarse, fine and separate confirmation probes. Four runs saved 36 cases/108 matched frames with passing control readback; three passed scene-candidate gates, while one remained diagnostic-only because its paper baseline exceeded the unchanged 220-DN brightness ceiling. A new confirmation capture used a shaded blank area of the same sheet chosen from the previous baseline. Its R/G improved from 1.0399 to 1.0014 and B/G from 1.1287 to 1.0147, using read-back gains [2.0390625,1,1,1.3945312] with that run's fixed CCM/exposure. The ROI's rendered neutral-error metric decreased by about 87.9%; this is not chart deltaE or general color calibration. AUTO return and session closure were verified. The scene-specific profile remains local and was not persistently applied. Long-sequence NR/motion quality comparison remains pending. See [simple tuning and focus inspection](simple-tuning.md).
