import { packager } from '@electron/packager';
import { cp, copyFile, mkdir, readFile, realpath, chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runtimeEnv, findExecutable } = require('../electron/runtime.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('This build script currently targets macOS.');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, '.build', 'app');
const backend = path.join(root, '.build', 'backend');
await mkdir(stage, { recursive: true });
await mkdir(backend, { recursive: true });
await cp(path.join(root, 'electron'), path.join(stage, 'electron'), { recursive: true });
await writeFile(path.join(stage, 'package.json'), JSON.stringify({
  name: metadata.name, productName: metadata.productName, version: metadata.version,
  description: metadata.description, main: metadata.main,
}, null, 2));
await cp(path.join(root, 'src'), path.join(backend, 'src'), { recursive: true });
const bun = findExecutable('bun', runtimeEnv(), process.env.OCEDIT_BUN);
await copyFile(await realpath(bun), path.join(backend, 'bun'));
await chmod(path.join(backend, 'bun'), 0o755);

const apps = await packager({
  dir: stage, out: path.resolve(root, process.env.OCEDIT_BUILD_OUT || 'dist'), name: metadata.productName,
  platform: 'darwin', arch: process.arch,
  electronVersion: require('electron/package.json').version,
  appBundleId: 'local.ocedit.desktop', appVersion: metadata.version,
  appCategoryType: 'public.app-category.developer-tools',
  asar: true, prune: false, overwrite: true,
  extraResource: [backend],
  osxSign: {
    identity: '-', identityValidation: false, continueOnError: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false }),
  },
  extendInfo: { NSHighResolutionCapable: true },
});
for (const output of apps) console.log(`Built: ${path.join(output, metadata.productName + '.app')}`);
