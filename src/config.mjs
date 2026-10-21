import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = fileURLToPath(new URL('..', import.meta.url));
export function configuration(env = process.env) {
  const root = path.resolve(env.GENIO_WORKSPACE || packageRoot);
  const sdkRoot = env.GENIO_ANDROID_SDK || env.ANDROID_HOME || env.ANDROID_SDK_ROOT
    || path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk');
  return {
    root, sdkRoot: path.resolve(sdkRoot),
    jdkRoot: env.GENIO_JDK || env.JAVA_HOME || 'C:\\Program Files\\Android\\Android Studio\\jbr',
    serial: env.GENIO_SERIAL || '',
    developmentKeystore: env.GENIO_CAMERA_KEYSTORE || '',
    allowSourceWrite: env.GENIO_ALLOW_SOURCE_WRITE === '1',
  };
}
