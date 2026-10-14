// The app can run the relay itself: enabling it brings this PC's host online on its own relay.
import net from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 15_000) {
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
  const read = (expr) => ctx.mainWindow.webContents.executeJavaScript(expr);
  const port = 47000 + Math.floor(Math.random() * 900);

  check('starts_without_relay', ctx.state().relay.running === false);

  await ctx.setRelay(true, port);
  await until(() => ctx.state().status === 'online', 'host online on its own relay');
  const s = ctx.state();
  check('relay_running', s.relay.running && s.relay.port === port, s.relay);
  check('server_points_to_local_relay', s.server === `ws://localhost:${port}/ws`, s.server);

  // the page lists the addresses other computers should use
  await until(async () => (await read("document.querySelectorAll('#relayAddresses li').length")) === s.relay.addresses.length, 'addresses rendered');
  check('addresses_shown', s.relay.addresses.every((a) => a.startsWith('ws://') && a.endsWith(`:${port}/ws`)), s.relay.addresses);

  // a busy port is reported clearly, and does not take the running relay down
  const blocker = net.createServer().listen(port + 1, '0.0.0.0');
  await new Promise((r) => blocker.once('listening', r));
  await ctx.setRelay(true, port + 1);
  const busy = ctx.state().relay;
  check('port_conflict_reported', busy.error.includes('déjà utilisé') && busy.running === false, busy.error);
  blocker.close();

  await ctx.setRelay(true, port);
  await until(() => ctx.state().status === 'online', 'online again');
  await ctx.setRelay(false, port);
  await until(() => ctx.state().status !== 'online', 'offline after stopping the relay');
  check('relay_stopped', ctx.state().relay.running === false);

  result.failed = Object.entries(result.checks).filter(([, v]) => !(v === true || v?.ok === true)).map(([k]) => k);
  result.error = result.failed.length ? `failed checks: ${result.failed.join(', ')}` : undefined;
  return result;
}
