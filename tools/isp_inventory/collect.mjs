import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GenioBackend } from '../../src/backend.mjs';
import { configuration } from '../../src/config.mjs';

const backend = new GenioBackend(configuration());
const directory = path.join(backend.root, 'outputs', 'isp-inventory', `inventory-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const report = { timestamp_utc: new Date().toISOString(), scope: 'Read-only board inventory; no setprop, root, topology changes or buffer dump enabling', artifacts: [] };
try {
  report.target = await backend.targetInfo();
  if (report.target.state !== 'device') throw new Error('Target is not ready');
  const commands = [
    ['identity', ['id']], ['properties', ['getprop']],
    ['camera-service', ['dumpsys', 'media.camera']], ['modules', ['cat', '/proc/modules']],
    ['devices', ['ls -l /dev/*cam* /dev/*isp* /dev/video* /dev/media* /dev/v4l-subdev*']],
    ['v4l-topology', ['ls -l /sys/class/video4linux; cat /sys/class/video4linux/video*/name']],
    ['camera-files', ['ls -ld /vendor/etc/camera* /data/vendor/camera* /sys/class/video4linux /sys/kernel/debug /d; ls /vendor/bin/*cam* /vendor/bin/hw/*camera*; ls /vendor/lib64/*cam* /vendor/lib64/hw/*camera*']],
    ['utilities', ['command -v strings; command -v v4l2-ctl; command -v media-ctl; getenforce']],
    ['existing-dumps', ['find /data/vendor/camera_dump -maxdepth 2 -type f']],
  ];
  for (const [name, args] of commands) {
    let stdout = '', stderr = '', status = 'PASS';
    try { ({ stdout, stderr } = await backend.adb(['shell', ...args])); }
    catch (error) { stdout = error.stdout || ''; stderr = error.stderr || error.message; status = 'UNAVAILABLE'; }
    const filename = `${name}.txt`;
    await fs.writeFile(path.join(directory, filename), stdout + stderr);
    report.artifacts.push({ name, file: filename, status, bytes: Buffer.byteLength(stdout + stderr) });
  }
  report.status = 'COLLECTED';
  report.limitation = 'Missing devices/permissions/utilities are recorded, not proof that a hardware feature is absent. Full block mapping and image output tests are separate.';
} catch (error) {
  report.status = 'TARGET_UNAVAILABLE'; report.error = error.message; process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, directory, error: report.error }));
}
