// Builds the distributable desktop app:  npm run dist
//   -> dist/Bifrost-win32-x64/Bifrost.exe   (a folder: zip it, or run the .exe in place)
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

const paths = await packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  name: 'Bifrost',
  executableName: 'Bifrost',
  platform: 'win32',
  arch: 'x64',
  appVersion: pkg.version,
  icon: path.join(ROOT, 'desktop', 'assets', 'icon.ico'),
  asar: false,
  prune: true,
  overwrite: true,
  ignore: (file) => EXCLUDE.some((re) => re.test(file)),
  win32metadata: {
    CompanyName: 'Bifrost',
    FileDescription: 'Bifrost - prise en main a distance',
    ProductName: 'Bifrost',
    OriginalFilename: 'Bifrost.exe',
  },
});

for (const p of paths) console.log('built:', p);
