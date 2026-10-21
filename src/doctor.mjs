import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GenioBackend } from './backend.mjs';

export async function doctor(config) {
  const backend = new GenioBackend(config);
  const checks = [];
  const check = async (name, action) => {
    try { const result = await action(); checks.push({ name, ok: true, result }); }
    catch (error) { checks.push({ name, ok: false, error: error.message }); }
  };
  await check('Node.js >=22', async () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Found ${process.version}`); return process.version; });
  await check('Workspace', async () => fs.realpath(config.root));
  await check('Git', async () => (await backend.command('git', ['--version'])).stdout.trim());
  await check('Windows Android runner', async () => { if (process.platform !== 'win32') throw new Error('Board build/deploy scripts currently require Windows'); return process.platform; });
  await check('Android SDK platform 35', async () => { await fs.access(path.join(config.sdkRoot, 'platforms/android-35/android.jar')); return config.sdkRoot; });
  await check('Android build-tools 35.0.0', async () => { for (const file of ['aapt2.exe', 'd8.bat', 'apksigner.bat', 'zipalign.exe']) await fs.access(path.join(config.sdkRoot, 'build-tools/35.0.0', file)); return '35.0.0'; });
  await check('JDK', async () => (await backend.command(path.join(config.jdkRoot, 'bin/javac.exe'), ['-version'])).stdout.trim());
  await check('Camera probe source', async () => { await fs.access(path.join(config.root, 'tools/android_camera/src/com/genio/cameraprobe/ProbeActivity.java')); return 'Present'; });
  await check('ADB device', async () => backend.targetInfo());
  return { status: checks.every(c => c.ok) ? 'PASS' : 'INCOMPLETE', source_writes_enabled: config.allowSourceWrite, checks };
}
