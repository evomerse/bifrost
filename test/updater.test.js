import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Updater, compareVersions, findChecksum, parseVersion, pickAsset, tarCommand } from '../desktop/updater.mjs';

const release = (tag, assets = []) => ({
  tag_name: tag,
  body: 'notes',
  html_url: `https://github.com/evomerse/bifrost/releases/tag/${tag}`,
  assets: assets.map((name) => ({
    name,
    size: 10,
    browser_download_url: `https://github.com/evomerse/bifrost/releases/download/${tag}/${name}`,
  })),
});

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test('versions are parsed and compared numerically', () => {
  assert.deepEqual(parseVersion('v1.20.3'), [1, 20, 3]);
  assert.equal(parseVersion('nope'), null);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('0.2.0', '0.3.0') < 0);
  assert.equal(compareVersions('garbage', '0.1.0'), 0, 'garbage is never "newer"');
});

test('the asset for this platform is picked by name', () => {
  const rel = release('v0.3.0', [
    'Bifrost-v0.3.0-win32-x64.zip',
    'Bifrost-v0.3.0-darwin-arm64.tar.gz',
    'Bifrost-v0.3.0-linux-x64.tar.gz',
    'SHA256SUMS.txt',
  ]);
  assert.equal(pickAsset(rel, 'win32', 'x64').name, 'Bifrost-v0.3.0-win32-x64.zip');
  assert.equal(pickAsset(rel, 'darwin', 'arm64').name, 'Bifrost-v0.3.0-darwin-arm64.tar.gz');
  assert.equal(pickAsset(rel, 'darwin', 'x64'), null);
  assert.equal(pickAsset(rel, 'linux', 'x64').name, 'Bifrost-v0.3.0-linux-x64.tar.gz');
});

test('checksums are read from sha256sum output', () => {
  const sum = 'a'.repeat(64);
  const text = `${sum}  Bifrost-v1-linux-x64.tar.gz\n${'B'.repeat(64)} *Bifrost-v1-win32-x64.zip\n`;
  assert.equal(findChecksum(text, 'Bifrost-v1-linux-x64.tar.gz'), sum);
  assert.equal(findChecksum(text, 'Bifrost-v1-win32-x64.zip'), 'b'.repeat(64));
  assert.equal(findChecksum(text, 'other'), null);
  assert.equal(findChecksum('short  file', 'file'), null);
});

test('Windows extracts with the system tar, not whatever is first in PATH', () => {
  assert.match(tarCommand('win32'), /System32[\\/]tar\.exe$/i);
  assert.equal(tarCommand('linux'), 'tar');
});

test('check(): newer release is reported, same or 404 is not', async () => {
  const mk = (resp) =>
    new Updater({ currentVersion: '0.2.0', fetchFn: async () => resp, platform: 'win32', arch: 'x64', installDir: null });

  const newer = await mk(json(release('v0.3.0', ['Bifrost-v0.3.0-win32-x64.zip']))).check();
  assert.equal(newer.available, true);
  assert.equal(newer.version, '0.3.0');
  assert.equal(newer.canInstall, false, 'a copy run from sources never installs itself');

  assert.equal((await mk(json(release('v0.2.0'))).check()).available, false);
  assert.equal((await mk(json({}, 404)).check()).available, false);
  await assert.rejects(mk(json({}, 500)).check(), /500/);
});

test('check(): installable when packaged and an asset exists', async () => {
  const u = new Updater({
    currentVersion: '0.2.0',
    platform: 'linux',
    arch: 'x64',
    installDir: '/opt/bifrost',
    fetchFn: async () => json(release('v0.3.0', ['Bifrost-v0.3.0-linux-x64.tar.gz', 'SHA256SUMS.txt'])),
  });
  assert.equal((await u.check()).canInstall, true);
});

test('install() refuses a release without checksums, a foreign host, or a wrong hash', async () => {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-upd-'));
  const name = 'Bifrost-v0.3.0-linux-x64.tar.gz';
  const base = { currentVersion: '0.2.0', platform: 'linux', arch: 'x64', installDir, exePath: path.join(installDir, 'Bifrost') };

  const noSums = new Updater({ ...base, fetchFn: async () => json(release('v0.3.0', [name])) });
  await noSums.check();
  await assert.rejects(noSums.install(), /SHA256SUMS/);

  const foreign = release('v0.3.0', [name, 'SHA256SUMS.txt']);
  foreign.assets[0].browser_download_url = 'https://evil.example/x.tar.gz';
  const bad = new Updater({ ...base, fetchFn: async () => json(foreign) });
  await bad.check();
  await assert.rejects(bad.install(), /inattendue/);

  const payload = Buffer.from('not the archive you expected');
  const fetchFn = async (url) => {
    if (url.includes('api.github.com')) return json(release('v0.3.0', [name, 'SHA256SUMS.txt']));
    if (url.endsWith('SHA256SUMS.txt')) return { ok: true, status: 200, text: async () => `${'0'.repeat(64)}  ${name}\n` };
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(payload.length) }),
      body: (async function* () {
        yield payload;
      })(),
    };
  };
  const wrong = new Updater({ ...base, fetchFn });
  await wrong.check();
  const progress = [];
  await assert.rejects(wrong.install((p) => progress.push(p)), /SHA-256/);
  assert.ok(progress.includes(1), 'progress reached 100 % before verification');
  assert.notEqual(crypto.createHash('sha256').update(payload).digest('hex'), '0'.repeat(64));
});
