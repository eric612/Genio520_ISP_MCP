# External algorithm replay reference

Version 0.4.1 adds an optional offline harness for the first WDR integration reference. It is a CLI helper, not an additional MCP tool or an Android algorithm port. The MCP server still exposes 13 tools. External enhancement code, delivered-artifact recipes and captures are not shipped or required by the server.

## Build a private snapshot

With an existing passed camera run containing every matched NV21 sample, an external `img_enhance` source tree, and a delivered image's `.provenance.json` sidecar:

```text
node tools/algorithm_replay/prepare.mjs CAMERA_RUN CASE_NAME EXTERNAL_SOURCE_ROOT ARTIFACT.png.provenance.json outputs/replay-bundle
python3 outputs/replay-bundle/harness/replay.py outputs/replay-bundle
```

The Python runner requires Python 3.10+, NumPy and OpenCV. It may run on a separate analysis machine using a copy of the complete bundle. The output directory must be new. It refuses changed snapshot hashes, mismatched timestamps, unsafe frame filenames, unsupported YUV ranges and incompatible reference stage families. It only copies regular top-level Python package files, not checkpoints or binary dependencies. The generated bundle contains private source and captured data and belongs in ignored outputs.

This first adapter deliberately supports the existing external `EnvelopeWDR`/`DarkChannelDefog` visual-pipeline family with explicit full-frame luma/chroma NR passthrough. It restores recorded stage attributes, discloses additional current-source defaults, preserves chroma coupling, and overrides Defog strength to zero for the clear-scene WDR isolation. It does not infer the current approved product from module defaults, a filename or modification time. A historical sidecar is a configuration reference, not proof that the old rendered pixels or current approved product have been reproduced.

## Evidence

The bundle holds source/input/recipe hashes, capture metadata and independent Node-decoded BGR reference bytes. Python must reproduce the Node BT601 full-range NV21 decoder exactly. The three output arms are original-NV21 identity, adapter-only conversion control, and WDR with chroma coupling. Complete sequence reset must reproduce WDR output bytes. Native BGR reference bytes and re-encoded NV21 are both saved; conversion error, including maximum error locations, is reported separately from algorithm changes.

Previews are decoded from the actual saved output NV21, at native capture size, grouped by frame in a 2×2 layout. `OFFLINE_REFERENCE_REPLAY_PASS` means input/source integrity and deterministic replay passed. It does not mean approved visual quality, restored highlights, lowlight performance, TTC improvement or Android execution. The observed near-white pixel increase and adapter loss must remain visible in the report. The first check used three real frames; a subsequent 64-frame sequence also passed integrity and deterministic replay checks. These short cold-state runs are not temporal-quality or sustained-performance acceptance. On the newer lit scene the historical recipe raised the near-white fraction from approximately 0.32-0.39% to 22.96-23.13%, so the setting was not promoted.
