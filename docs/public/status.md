# Validation status — 2026-10-21

Version 0.2.0 provides a generic MCP bridge with 11 tools. Standard Node.js 22 and the MCP SDK are the only server runtime requirements; camera operations additionally use locally installed Android/JDK tools. No indexer, vendor BSP, shared model key or board credentials are included.

Verified locally:

- Fresh source export installed all 95 locked package instances with `npm ci --ignore-scripts`.
- Eight tests passed, including real stdio and Streamable HTTP MCP clients performing source read, SHA256-checked edit, Git diff and selective commit in isolated workspaces.
- Negative tests cover stale edits, ambiguous replacements, existing-file creation, private/generated paths, Windows reserved paths, junctions/hardlinks, invalid HTTP credentials, Host and Origin.
- The independent source checkout built and deployed a Camera2 APK through MCP on a Genio 520 running Android 15/API 35.
- All 7 control cases passed, with 3 timestamp-matched YUV/result frames per case (21 total). Exposure, ISO, NR/tone modes and requested three-channel tone curves passed the implemented readback checks.

The board already had the diagnostic application installed. Its existing local development keystore was explicitly reused for the update; no signing key is shipped with this repository. Captures, APKs and raw board reports remain local and are not repository content.

The tested source checkout is a new Git history. Internal project documents, official photographs, private MCP settings and SDK binaries are excluded.

Browser account connections, public OAuth hosting, multi-user device isolation and sustained ISP performance are not part of this generic MCP acceptance. Browser-specific setup remains a separate optional step. This bridge does not include WDR/Defog/TNR algorithm implementations.
