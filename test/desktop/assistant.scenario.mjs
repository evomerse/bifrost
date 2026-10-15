// The two sides of a remote session, in the real app:
//   - this PC (host): the session box at the bottom right, the conversation in it, and what the
//     other side's assistant does being written there;
//   - the viewer window (technician): Heimdall's panel, whose tools run on the host through the
//     encrypted channel. The model is a stub (no network): it asks for system_info, then answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
import { createBifrostServer } from '../../server/server.js';
import { setPassword } from '../../agent/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(120);
  }
}

export async function run(ctx) {
  const result = { checks: {} };
  const check = (name, ok, detail) => {
    result.checks[name] = detail === undefined ? Boolean(ok) : { ok: Boolean(ok), detail };
  };

  const relay = createBifrostServer({ port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-a-relay-')) });
  const port = await relay.listen();
  const cfg = ctx.cfg;
  cfg.server = `ws://127.0.0.1:${port}/ws`;
  cfg.transferDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-a-transfers-'));
  cfg.assistant = true;
  await setPassword(cfg, 'assistant-test-password');
  ctx.saveCfg();
  ctx.restartHosting();
  await until(() => ctx.state().status === 'online', 'host online');
  check('permission_in_state', ctx.state().assistant === true);

  // Heimdall on this Bifrost: enabled, a key, and a model that is a stub
  const main = ctx.mainWindow.webContents;
  await main.executeJavaScript(`window.bifrost.setHeimdall({ enabled: true, provider: 'groq' })`);
  await main.executeJavaScript(`window.bifrost.setHeimdall({ apiKey: 'gsk_TEST_0123456789' })`);
  const modelCalls = [];
  const answers = [
    { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'system_info', arguments: '{}' } }] } }] },
    { choices: [{ message: { content: 'Le PC distant va bien.' } }] },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.groq.com')) return realFetch(url, init);
    modelCalls.push(JSON.parse(init.body));
    return { ok: true, status: 200, statusText: 'OK', json: async () => answers.shift() };
  };

  const windowsWith = (suffix) =>
    electron.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().endsWith(suffix));
  const boxWindow = () => windowsWith('/indicator.html')[0] ?? null;

  // --- control session -------------------------------------------------------------------
  const win = ctx.openViewer({ id: cfg.id, password: 'assistant-test-password', mode: 'control', label: 'Camille' });
  const page = (expr) => win.webContents.executeJavaScript(expr);
  await until(() => page(`!document.getElementById('stage').hidden`), 'viewer stage shown');

  // the session box: bottom right of the work area, folded to a slim bar
  const box = await until(boxWindow, 'session box');
  await until(() => box.webContents.executeJavaScript(`document.getElementById('detail').textContent.includes('Camille')`), 'box filled');
  const wa = electron.screen.getPrimaryDisplay().workArea;
  const b = box.getBounds();
  check('box_at_bottom_right', Math.abs(wa.x + wa.width - (b.x + b.width)) <= 40 && Math.abs(wa.y + wa.height - (b.y + b.height)) <= 40, { b, wa });
  check('box_folded_at_start', b.height < 120 && (await box.webContents.executeJavaScript(`document.getElementById('boxChat').hidden`)), b);
  check('box_always_on_top', box.isAlwaysOnTop());

  // the viewer writes: the box unfolds by itself and shows the line
  await until(() => page(`!document.getElementById('talkBtn').hidden`), 'chat available in the viewer');
  await page(`(() => { document.getElementById('talkInput').value = 'Bonjour, je vais regarder'; document.getElementById('talkForm').requestSubmit(); })()`);
  await until(() => box.webContents.executeJavaScript(`document.getElementById('chatLog').innerText.includes('Bonjour, je vais regarder')`), 'message shown in the box');
  const unfolded = box.getBounds();
  check('box_unfolds_on_message', unfolded.height > 300 && !(await box.webContents.executeJavaScript(`document.getElementById('boxChat').hidden`)), unfolded);
  check('box_keeps_its_corner', Math.abs(unfolded.y + unfolded.height - (b.y + b.height)) <= 2 && unfolded.x === b.x, { b, unfolded });
  check('box_does_not_steal_focus', !box.isFocused());

  // the person at this PC answers from the box
  await box.webContents.executeJavaScript(`(() => { document.getElementById('chatInput').value = 'Merci, allez-y'; document.getElementById('chatForm').requestSubmit(); })()`);
  await until(() => page(`document.getElementById('talkLog').innerText.includes('Merci, allez-y')`), 'answer reaches the viewer');
  check('answer_from_box_reaches_viewer', true);

  // --- Heimdall in the viewer --------------------------------------------------------------
  await until(() => page(`!document.getElementById('aiBtn').hidden`), 'Heimdall button offered');
  check('assistant_button_in_control_mode', true);
  await page(`document.getElementById('aiBtn').click()`);
  check('assistant_panel_opens_and_closes_chat', await page(`!document.getElementById('aiPanel').hidden && document.getElementById('talkPanel').hidden`));
  await page(`(() => { document.getElementById('aiInput').value = 'comment va ce PC ?'; document.getElementById('aiForm').requestSubmit(); })()`);
  const log = await until(async () => {
    const t = await page(`document.getElementById('aiLog').innerText`);
    return t.includes('Le PC distant va bien.') ? t : null;
  }, 'Heimdall answer');
  check('tool_ran_on_the_host', /system_info/.test(log) && /Nom\s*:/.test(log) && /Système\s*:/.test(log), log);
  check('model_got_the_tool_result', modelCalls.length === 2 && modelCalls[1].messages.at(-1).role === 'tool' && /Nom\s*:/.test(modelCalls[1].messages.at(-1).content), modelCalls.length);
  check('remote_system_prompt', /ordinateur distant/.test(modelCalls[0].messages[0].content), modelCalls[0].messages[0].content);
  check('model_sees_host_tools', modelCalls[0].tools.some((t) => t.function.name === 'run_command'));

  // the person at this PC is told what the assistant did
  const note = await until(
    () => box.webContents.executeJavaScript(`document.querySelector('.msg.sys')?.textContent ?? ''`).then((t) => (t.includes('Camille') ? t : null)),
    'assistant activity in the box',
  );
  check('activity_written_in_the_box', /consulte les informations/.test(note), note);

  // not reachable from the host's own control panel pages, nor without a session
  const fromPanel = await main.executeJavaScript(`typeof window.bifrostDesktop`);
  check('no_viewer_api_in_panel', fromPanel === 'undefined', fromPanel);

  // ending the session closes the box and drops the assistant of that window
  await page(`document.getElementById('stop').click()`);
  await until(() => boxWindow() === null, 'box closed');
  check('box_closed_with_session', true);
  win.destroy();

  // --- view-only session: no assistant ---------------------------------------------------------
  await until(() => ctx.state().session === null, 'host idle');
  const viewOnly = ctx.openViewer({ id: cfg.id, password: 'assistant-test-password', mode: 'view', label: 'Camille' });
  await until(() => viewOnly.webContents.executeJavaScript(`!document.getElementById('stage').hidden`), 'view-only stage');
  await sleep(500);
  check('no_assistant_in_view_only', await viewOnly.webContents.executeJavaScript(`document.getElementById('aiBtn').hidden`));
  viewOnly.destroy();

  globalThis.fetch = realFetch;
  await relay.close();
  result.failed = Object.entries(result.checks).filter(([, v]) => !(v === true || v?.ok === true)).map(([k]) => k);
  result.error = result.failed.length ? `failed checks: ${result.failed.join(', ')}` : undefined;
  return result;
}
