import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { GenioBackend } from './backend.mjs';
import { configuration } from './config.mjs';

export function createServer(backend) {
const server = new McpServer({ name: 'genio-dev', version: '0.4.2' });
function tool(name, description, schema, action, annotations = {}) {
  server.registerTool(name, { description, inputSchema: schema, annotations }, async args => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(await action(args)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}
tool('get_target_info', 'Read Genio Android/ABI/build and ADB status. No system changes.', {}, () => backend.targetInfo(), { readOnlyHint: true });
tool('get_camera_capabilities', 'Read HAL-advertised camera metadata. Availability is distinct from verified control effects.', {}, () => backend.cameraCapabilities(), { readOnlyHint: true });
tool('build_camera_probe', 'Build the diagnostic Camera2 APK using the existing local Android SDK/JDK. Returns source and APK hashes.', {}, () => backend.buildCamera());
tool('run_camera_validation', 'Deploy a built diagnostic APK: capture, controls, inventory, raw, jpeg, nr, wb or nr_sequence. NR sequence freezes current AUTO exposure/ISO/WB/CCM and saves 64 matched YUV samples per manual case across standard NR/vendor 3DNR 0/1, with baseline return and AUTO restoration. Static quality only; no motion test. Closes built-in camera app, wakes board, grants CAMERA permission; returns job ID.', {
  suite: z.enum(['capture', 'controls', 'inventory', 'raw', 'nr', 'wb', 'jpeg', 'nr_sequence']).default('controls'),
  camera_id: z.string().regex(/^\d+$/).default('0'),
  wb_candidates: z.array(z.array(z.number().min(1).max(4)).length(4)).min(1).max(12).optional().describe('WB-only R/Ge/Go/B probe vectors. Values above 3 are device-specific; readback must verify acceptance. Always returns through baseline and AUTO.'),
  still_exposure_ns: z.number().int().min(1).max(400000000).optional().describe('RAW/JPEG still only: fixed exposure, with ISO scaled from auto baseline and clamped to advertised range. Device reports actual values.'),
}, args => backend.startValidation({ suite: args.suite, cameraId: args.camera_id, wbCandidates: args.wb_candidates, stillExposureNs: args.still_exposure_ns }));
tool('get_job', 'Read asynchronous build/capture job status.', { job_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }, args => backend.getJob(args.job_id), { readOnlyHint: true });
tool('get_report', 'Read a local validation report and artifact paths. Summary is the default.', {
  run_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), full: z.boolean().default(false),
}, args => backend.getReport(args.run_id, args.full), { readOnlyHint: true });
tool('evaluate_wb', 'Measure a completed WB run on the same ROI, compare with fixed baseline and verified return, and save a local comparison report. A neutral reference must be physically established before confirming it. Returns a scene-specific candidate only when measurement/readback/restore gates pass; otherwise keeps baseline or diagnostics. Does not change the camera.', {
  run_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  roi: z.array(z.number().min(0).max(1)).length(4).describe('Normalized left, top, right, bottom in captured YUV coordinates'),
  neutral_reference_confirmed: z.boolean().default(false),
}, args => backend.evaluateWb(args.run_id, args.roi, args.neutral_reference_confirmed), { destructiveHint: false });
tool('evaluate_nr', 'Evaluate a completed nr_sequence run on a fixed static ROI: temporal Y noise, drift, clipping, baseline return and missing frames. Saves a local comparison; does not alter the camera or select/install a profile. Static scene must be checked by a person; no lux, motion/ghosting or sensor-noise claim.', {
  run_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  roi: z.array(z.number().min(0).max(1)).length(4).describe('Normalized left,top,right,bottom in the fixed captured scene'),
}, args => backend.evaluateNr(args.run_id, args.roi), { destructiveHint: false });
tool('commit_candidate', 'Commit exactly the listed individual Genio source files. Never operates on IMG_ENHANCE or TTC, never pushes, and refuses unrelated staged files.', {
  files: z.array(z.string()).min(1).max(80), message: z.string().min(1).max(2000),
}, args => {
  if (!backend.workspace.writable) throw new Error('Source editing is disabled; start with GENIO_ALLOW_SOURCE_WRITE=1');
  return backend.commitCandidate(args.files, args.message);
}, { destructiveHint: false });

tool('list_source_files', 'List allowed source files in the configured workspace. Does not require a board or Trail.', {
  limit: z.number().int().min(1).max(1000).default(300),
}, args => backend.workspace.list(args.limit), { readOnlyHint: true });

tool('read_source_file', 'Read one allowed UTF-8 source file, including its SHA256 for conflict checking.', {
  path: z.string().min(1),
}, args => backend.workspace.read(args.path), { readOnlyHint: true });

tool('edit_source_file', 'Edit one source file using exact unique replacements and the SHA256 returned by read_source_file. NEW creates a file exclusively in an existing directory using content. Requires source write opt-in; never deletes files.', {
  path: z.string().min(1), expected_sha256: z.string(),
  replacements: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() })).min(1).max(40).optional(),
  content: z.string().optional(),
}, args => {
  return backend.editSource({ path: args.path, expectedSha256: args.expected_sha256, replacements: args.replacements, content: args.content });
}, { destructiveHint: false });

tool('get_source_diff', 'Read Git status plus unstaged and staged changes for explicitly selected source files.', {
  files: z.array(z.string()).min(1).max(80),
}, args => backend.sourceDiff(args.files), { readOnlyHint: true });

return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createServer(new GenioBackend(configuration())).connect(new StdioServerTransport());
}
