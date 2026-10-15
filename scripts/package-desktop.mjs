// Builds the distributable desktop app:  npm run dist [-- --platform=win32|darwin|linux --arch=x64|arm64]
//   -> dist/Bifrost-win32-x64/Bifrost.exe   (a folder: zip it, or run the .exe in place)
//   -> dist/Bifrost-darwin-arm64/Bifrost.app, dist/Bifrost-linux-x64/Bifrost
// By default it builds for the machine it runs on.
//
// asar is off on purpose: the host starts PowerShell scripts and a helper .exe, and external
// processes cannot read files inside an asar archive.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Everything that is not needed at run time (paths are relative to the project, with a slash).
const EXCLUDE = [
  /^\/test(\/|$)/,
  /^\/docs(\/|$)/,
  /^\/dist(\/|$)/,
  /^\/data(\/|$)/,
  /^\/scripts(\/|$)/,
  /^\/\.git/,
  /^\/\.gitignore$/,
  /^\/package-lock\.json$/,
  // runtime dependency is ws only; the build tools (and the electron package) stay out
  /^\/node_modules\/(?!ws(\/|$)).+/,
  /^\/desktop\/assets\/make-icons\.ps1$/,
  /^\/desktop\/assets\/logo-source\.jpg$/,
];

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`unsupported target ${platform}-${arch}`);
}
// .ico on Windows; macOS (.icns) and Linux get Electron's default file icon: the windows set
// their own icon at run time.
const icon = platform === 'win32' ? path.join(ROOT, 'desktop', 'assets', 'icon.ico') : undefined;

const paths = await packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  name: 'Bifrost',
  executableName: 'Bifrost',
  platform,
  arch,
  appVersion: pkg.version,
  icon,
  asar: false,
  prune: true,
  overwrite: true,
  ignore: (file) => EXCLUDE.some((re) => re.test(file)),
  win32metadata: platform !== 'win32' ? undefined : {
    CompanyName: 'Bifrost',
    FileDescription: 'Bifrost - prise en main a distance',
    ProductName: 'Bifrost',
    OriginalFilename: 'Bifrost.exe',
  },
});

for (const p of paths) console.log('built:', p);
