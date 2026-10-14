import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPermissions, describePermissions } from '../agent/permissions.js';

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'agent.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('defaults: clipboard on, files ask, drop box + outbox, nothing created on disk', () => {
  const base = tmp('bf-perm-');
  const p = buildPermissions({ transferDir: path.join(base, 'T') });
  assert.equal(p.clipboard, true);
  assert.equal(p.fileTransfer, 'ask');
  assert.deepEqual(p.roots.map((r) => [r.name, r.read, r.write]), [['Inbox', true, true], ['Outbox', true, false]]);
  assert.deepEqual(fs.readdirSync(base), [], 'building permissions must not touch the disk');

  p.ensureDirs();
  assert.deepEqual(fs.readdirSync(path.join(base, 'T')).sort(), ['Inbox', 'Outbox']);
});

test('service (SYSTEM): only a write-only drop box, shares are ignored', () => {
  const shared = tmp('bf-share-');
  const baseDir = tmp('bf-svc-');
  const p = buildPermissions({ shares: [{ name: 'Docs', dir: shared, write: true }] }, { serviceMode: true, baseDir });
  assert.deepEqual(p.roots.map((r) => [r.name, r.read, r.write]), [['Inbox', false, true]]);
  assert.equal(p.roots[0].dir, path.join(baseDir, 'Transfers', 'Inbox'));
});

test('user mode: declared shares are offered, missing ones are not', () => {
  const docs = tmp('bf-docs-');
  const p = buildPermissions({
    transferDir: path.join(tmp('bf-base-'), 'T'),
    shares: [
      { name: 'Docs', dir: docs, write: true },
      { name: 'Gone', dir: path.join(docs, 'does-not-exist') },
      { name: 42, dir: docs },
    ],
  });
  assert.deepEqual(p.roots.map((r) => r.name), ['Inbox', 'Outbox', 'Docs']);
  assert.deepEqual([p.roots[2].read, p.roots[2].write], [true, true]);
});

test('invalid settings fall back to the safe default', () => {
  const p = buildPermissions({ fileTransfer: 'yes please', clipboard: 'maybe', transferDir: tmp('bf-x-') });
  assert.equal(p.fileTransfer, 'ask');
  assert.equal(p.clipboard, true); // only an explicit false disables it
  assert.equal(buildPermissions({ clipboard: false, fileTransfer: 'deny', transferDir: tmp('bf-y-') }).clipboard, false);
});

test('describePermissions does not create anything', () => {
  const base = tmp('bf-desc-');
  const text = describePermissions({ transferDir: path.join(base, 'T') }, false);
  assert.match(text, /Presse-papiers : autorise/);
  assert.match(text, /\/Inbox/);
  assert.deepEqual(fs.readdirSync(base), []);
});

test('permissions command: saves the settings and changes nothing else on the machine', () => {
  const home = tmp('bf-home-');
  const cfg = path.join(tmp('bf-cfg-'), 'agent.json');
  const share = tmp('bf-sharedir-');
  const run = (...args) =>
    spawnSync(process.execPath, [AGENT, 'permissions', '--config', cfg, ...args], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });

  let r = run('--clipboard', 'off', '--files', 'allow');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Presse-papiers : desactive/);
  assert.match(r.stdout, /sans demander/);

  r = run('--share', share, '--share-name', 'Mes docs', '--share-write');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\/Mes docs/);
  const saved = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(saved.clipboard, false);
  assert.equal(saved.fileTransfer, 'allow');
  assert.deepEqual(saved.shares, [{ name: 'Mes docs', dir: share, write: true }]);

  r = run('--unshare', 'Mes docs');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).shares, []);

  assert.notEqual(run('--files', 'sometimes').status, 0, 'invalid value rejected');
  assert.notEqual(run('--share', path.join(share, 'nope')).status, 0, 'missing folder rejected');
  assert.notEqual(run('--share', share, '--share-name', 'Inbox').status, 0, 'reserved name rejected');
  assert.deepEqual(fs.readdirSync(home), [], 'no folder was created in the user profile');
});
