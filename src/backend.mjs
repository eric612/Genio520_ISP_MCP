import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Workspace, sourcePath } from './workspace.mjs';
export { sourcePath } from './workspace.mjs';

const execute = promisify(execFile);
export function childEnvironment(environment = process.env) {
  // MCP stdio clients can omit PATHEXT. Windows PowerShell then opens .exe
  // files as documents instead of waiting for a native process and exit code.
  return { ...environment, PATHEXT: environment.PATHEXT || '.COM;.EXE;.BAT;.CMD' };
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function validateId(value) {
  if (!ID.test(value)) throw new Error('Invalid run/job identifier');
  return value;
}
async function readJson(file) {
  const info = await fs.stat(file);
  if (info.size > 8 * 1024 * 1024) throw new Error('JSON report is too large');
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2));
  await fs.rename(temporary, file);
}
export function parseCameraDump(text) {
  const cameraCount = Number(text.match(/Number of camera devices:\s*(\d+)/)?.[1] ?? 0);
  const metadata = {};
  const expression = /^\s{6}([\w.]+) \([0-9a-f]+\):[^\r\n]*\r?\n((?:[ \t]{8}\[[^\r\n]*\r?\n)+)/gm;
  for (const match of text.matchAll(expression)) metadata[match[1]] = match[2].trim();
  return {
    camera_count: cameraCount,
    advertised_metadata: metadata,
    limitation: 'HAL declarations; control effects require a validation run. Metadata parsing is a diagnostic convenience, not a complete Camera2 API implementation.',
  };
}

export class GenioBackend {
  constructor({ root, sdkRoot, jdkRoot, serial = '', developmentKeystore = '', allowSourceWrite = false, executor = execute }) {
    this.root = path.resolve(root);
    this.sdkRoot = sdkRoot;
    this.serial = serial;
    this.jdkRoot = jdkRoot;
    this.developmentKeystore = developmentKeystore;
    this.workspace = new Workspace(this.root, { writable: allowSourceWrite });
    this.adbPath = path.join(sdkRoot, 'platform-tools', 'adb.exe');
    this.execute = executor;
    this.jobs = new Map();
    this.busy = false;
  }
  async command(file, args, timeout = 30000) {
    const { stdout, stderr } = await this.execute(file, args, {
      cwd: this.root, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
      env: childEnvironment(),
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '' };
  }
  async adb(args, timeout = 30000) {
    return this.command(this.adbPath, [...(this.serial ? ['-s', this.serial] : []), ...args], timeout);
  }
  async targetInfo() {
    const version = await this.command(this.adbPath, ['version']);
    const state = (await this.adb(['get-state'])).stdout.trim();
    const resolvedSerial = (await this.adb(['get-serialno'])).stdout.trim();
    const properties = {};
    for (const key of ['ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abi', 'ro.soc.model', 'ro.build.display.id', 'sys.boot_completed']) {
      properties[key] = (await this.adb(['shell', 'getprop', key])).stdout.trim();
    }
    return { serial: resolvedSerial, state, adb_version: version.stdout.trim(), properties };
  }
  async cameraCapabilities() {
    const result = await this.adb(['shell', 'dumpsys', 'media.camera']);
    return parseCameraDump(result.stdout);
  }
  async buildCamera() {
    if (this.busy) throw new Error('A camera build or validation is already running');
    this.busy = true;
    try {
      await this.command('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(this.root, 'tools', 'android_camera', 'build.ps1'), '-SdkRoot', this.sdkRoot,
        ...(this.jdkRoot ? ['-JdkRoot', this.jdkRoot] : []),
        ...(this.developmentKeystore ? ['-DevelopmentKeystore', this.developmentKeystore] : []),
      ], 120000);
      return await readJson(path.join(this.root, 'outputs', 'android-camera', 'build', 'build.json'));
    } finally { this.busy = false; }
  }
  async startValidation({ suite = 'controls', cameraId = '0' } = {}) {
    if (!['capture', 'controls', 'inventory', 'raw', 'nr'].includes(suite) || !/^\d+$/.test(cameraId)) throw new Error('Invalid suite/camera');
    if (this.busy) throw new Error('A camera build or validation is already running');
    this.busy = true;
    const id = `camera-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const job = { id, run_id: id, kind: 'camera_validation', status: 'running', suite, camera_id: cameraId, started_utc: new Date().toISOString() };
    const jobDir = path.join(this.root, 'outputs', 'mcp-jobs');
    const jobFile = path.join(jobDir, `${id}.json`);
    let child;
    try {
      await fs.access(path.join(this.root, 'outputs', 'android-camera', 'build', 'build.json'));
      await atomicJson(jobFile, job);
      const logHandle = await fs.open(path.join(jobDir, `${id}.log`), 'a');
      try {
        child = spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          path.join(this.root, 'tools', 'android_camera', 'run.ps1'),
          '-SkipBuild', ...(this.serial ? ['-Serial', this.serial] : []), '-SdkRoot', this.sdkRoot,
          '-Suite', suite, '-CameraId', cameraId, '-RunId', id,
        ], { cwd: this.root, windowsHide: true, env: childEnvironment(), stdio: ['ignore', logHandle.fd, logHandle.fd] });
      } finally { await logHandle.close(); }
      this.jobs.set(id, { job, child });
      let completed = false;
      const complete = async (code, error) => {
        if (completed) return;
        completed = true;
        this.busy = false;
        job.status = code === 0 && !error ? 'succeeded' : 'failed';
        job.exit_code = code;
        job.finished_utc = new Date().toISOString();
        if (error) job.error = String(error);
        job.report_path = `outputs/camera-runs/${id}/report.json`;
        try { await atomicJson(jobFile, job); }
        catch (writeError) { console.error('Cannot persist job completion:', writeError.message); }
      };
      child.once('error', error => { void complete(null, error); });
      child.once('exit', code => { void complete(code); });
      return { ...job };
    } catch (error) {
      this.busy = false;
      if (child) child.kill();
      throw error;
    }
  }
  async getJob(id) {
    validateId(id);
    const live = this.jobs.get(id);
    const job = live ? { ...live.job } : await readJson(path.join(this.root, 'outputs', 'mcp-jobs', `${id}.json`));
    if (!live && job.status === 'running') job.status = 'unknown_after_server_restart';
    try {
      const report = await readJson(path.join(this.root, 'outputs', 'camera-runs', id, 'report.json'));
      job.capture_status = report.status;
      job.completed_cases = report.cases?.length ?? 0;
    } catch (error) { if (error.code !== 'ENOENT') job.report_read_error = error.message; }
    return job;
  }
  async getReport(id, full = false) {
    validateId(id);
    const directory = path.join(this.root, 'outputs', 'camera-runs', id);
    const report = await readJson(path.join(directory, 'report.json'));
    if (full) return { directory, report };
    return {
      directory, status: report.status, camera_id: report.camera_id, width: report.width, height: report.height,
      controls_readback_match: report.controls_readback_match, error: report.error, limitations: report.limitations,
      suite: report.suite, raw: report.raw, raw_yuv_timestamps_match: report.raw_yuv_timestamps_match,
      inventory_summary: report.inventory && { characteristics: Object.keys(report.inventory.characteristics).length,
        request_keys: report.inventory.request_keys.length, result_keys: report.inventory.result_keys.length,
        session_keys: report.inventory.session_keys.length, output_formats: report.inventory.output_formats },
      cases: (report.cases ?? []).map(c => ({
        name: c.name, requested: c.requested, controls_readback_match: c.requested_controls_readback_match,
        samples: c.frames?.length,
        first_frame: c.frames?.[0] && {
          exposure_time_ns: c.frames[0].exposure_time_ns, iso: c.frames[0].iso,
          nr_mode: c.frames[0].nr_mode, vendor_3dnr_mode: c.frames[0].vendor_3dnr_mode, tone_mode: c.frames[0].tone_mode,
          luma_mean: c.frames[0].luma_mean, luma_stddev: c.frames[0].luma_stddev,
          tone_curve_max_abs_error: c.frames[0].tone_curve_max_abs_error,
          image_timestamp_ns: c.frames[0].image_timestamp_ns, sensor_timestamp_ns: c.frames[0].sensor_timestamp_ns,
          nv21: c.frames[0].nv21, jpeg: c.frames[0].jpeg,
        },
      })),
    };
  }
  async commitCandidate(files, message) {
    if (this.busy) throw new Error('Wait for the active build/validation before committing');
    this.busy = true;
    try {
    if (!Array.isArray(files) || !files.length || files.length > 80) throw new Error('Specify 1 to 80 source files');
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw new Error('Invalid commit message');
    const canonicalRoot = await fs.realpath(this.root);
    for (const file of files) {
      await this.workspace.resolve(file);
      const candidate = sourcePath(this.root, file);
      const real = await fs.realpath(candidate);
      const relative = path.relative(canonicalRoot, real);
      if (relative.startsWith('..') || path.isAbsolute(relative) || real !== candidate) throw new Error('Symlink/outside-root source not allowed');
      if (!(await fs.stat(real)).isFile()) throw new Error('Commit paths must name individual files');
    }
    const staged = (await this.command('git', ['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean);
    if (staged.some(file => !files.includes(file))) throw new Error('Unrelated files are staged; preserve and resolve that index first');
    await this.command('git', ['add', '--', ...files]);
    await this.command('git', ['commit', '--only', '-m', message, '--', ...files]);
    const sha = (await this.command('git', ['rev-parse', 'HEAD'])).stdout.trim();
    return { commit_sha: sha, files };
    } finally { this.busy = false; }
  }
  async editSource(args) {
    if (this.busy) throw new Error('Wait for the active build/validation before editing sources');
    this.busy = true;
    try { return await this.workspace.edit(args); }
    finally { this.busy = false; }
  }
  async sourceDiff(files) {
    if (!Array.isArray(files) || !files.length || files.length > 80) throw new Error('Specify 1 to 80 source files');
    for (const file of files) await this.workspace.resolve(file);
    const status = await this.command('git', ['status', '--short', '--', ...files]);
    const diff = await this.command('git', ['diff', '--no-ext-diff', '--no-textconv', '--', ...files]);
    const staged = await this.command('git', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', ...files]);
    return { status: status.stdout, diff: diff.stdout, staged_diff: staged.stdout,
      note: 'Untracked file content is available via read_source_file; git diff does not include it.' };
  }
}
