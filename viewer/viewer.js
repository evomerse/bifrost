import {
  ViewerE2E,
  KIND_FILE,
  KIND_FRAME,
  KIND_JSON,
  KIND_VIDEO,
  codecStringFromAnnexB,
  packFileBody,
  parseJsonBody,
  unpackFileBody,
  unpackFrameBody,
  unpackVideoBody,
} from '/shared/e2e.js';
import { createAssistant } from '/assistant.js';
import { createChat } from '/chat.js';
import { createExtras } from '/extras.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const statusEl = $('status');
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const extras = createExtras($);
const chat = createChat($);

const MODS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
const BUTTONS = { 0: 'l', 1: 'm', 2: 'r' };

const ERRORS = {
  offline: 'Cet identifiant est hors ligne ou inconnu.',
  busy: 'Cet ordinateur est déjà en cours de contrôle.',
  rate_limited: 'Trop de tentatives, réessayez dans une minute.',
};
const DENIED = {
  refused: 'La personne en face a refusé la connexion.',
  bad_password: 'Mot de passe incorrect.',
  locked: 'Trop d’essais incorrects : accès par mot de passe bloqué quelques minutes.',
  no_password: 'Cet ordinateur n’a pas de mot de passe : laissez le champ vide pour demander l’accord.',
  bad_request: 'Échange de clés refusé (message altéré ou version incompatible).',
};
const ENDED = {
  'host-offline': 'L’ordinateur distant s’est déconnecté.',
  'host-ended': 'La session a été terminée par l’ordinateur distant.',
  'host-replaced': 'L’ordinateur distant s’est reconnecté.',
};

let ws = null;
let e2e = null;
let challenge = null;
let mode = 'control';
let active = false;
let finished = false;

// --- remembered, non-sensitive preferences ----------------------------------------------
try {
  $('label').value = localStorage.getItem('bifrost.label') ?? '';
} catch {
  /* storage blocked */
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function showStage(on) {
  $('connect').hidden = on;
  $('stage').hidden = !on;
  if (on) showBar(true); // every session starts with the toolbar visible
  if (on) canvas.focus();
}

/** The toolbar can be folded away (full screen use); a small tab at the top brings it back. */
function showBar(on) {
  $('stage').classList.toggle('bar-hidden', !on);
  $('barShow').hidden = on;
  if (document.activeElement && document.activeElement !== canvas) canvas.focus();
}
$('barHide').addEventListener('click', () => showBar(false));
$('barShow').addEventListener('click', () => showBar(true));

/** Plaintext: only the handshake and server-level control (leave). */
function sendPlain(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** End-to-end encrypted: everything after the handshake, notably all input events. */
function sendSecure(msg) {
  if (!e2e?.channel) return;
  const socket = ws;
  e2e.channel
    .sealJson(msg)
    .then((packet) => socket && socket.readyState === WebSocket.OPEN && socket.send(packet))
    .catch(() => {});
}

/** Encrypted packet of another kind (file chunks). */
function sendSecureKind(kind, body) {
  if (!e2e?.channel) return;
  const socket = ws;
  e2e.channel
    .seal(kind, body)
    .then((packet) => socket && socket.readyState === WebSocket.OPEN && socket.send(packet))
    .catch(() => {});
}

// --- connection -------------------------------------------------------------------------
// In the desktop app the page is opened with a preload that supplies the relay address and,
// for a connection started from the main window, what to connect to (nothing in the URL).
const desktop = globalThis.bifrostDesktop ?? null;
const assistant = createAssistant($, desktop);

function relayUrl() {
  if (desktop?.serverUrl) return desktop.serverUrl;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/** Closes this window: through the desktop app (reliable), else the browser's own call. */
function closeWindow() {
  if (typeof desktop?.close === 'function') desktop.close();
  else window.close();
}
$('closeWin').addEventListener('click', closeWindow);

// After a clean end in the desktop app the window closes by itself; "Se reconnecter" cancels it.
let closeTimer = null;
function cancelCountdown() {
  clearTimeout(closeTimer);
  closeTimer = null;
  $('countdown').hidden = true;
}
function startCountdown(seconds) {
  let left = seconds;
  const tick = () => {
    $('countdown').hidden = false;
    $('countdown').textContent = `Cette fenêtre se ferme dans ${left} s.`;
    if (left <= 0) return closeWindow();
    left -= 1;
    closeTimer = setTimeout(tick, 1000);
    return undefined;
  };
  tick();
}
$('again').addEventListener('click', () => {
  cancelCountdown();
  $('endedActions').hidden = true;
  form.hidden = false;
  setStatus('');
  $('password').focus();
});


form.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('id').value.replace(/\s+/g, '');
  if (!/^\d{9}$/.test(id)) return setStatus('L’identifiant comporte 9 chiffres.', true);
  if (!globalThis.crypto?.subtle) {
    return setStatus('Le chiffrement exige HTTPS (ou localhost) : ouvrez cette page en HTTPS.', true);
  }
  try {
    localStorage.setItem('bifrost.label', $('label').value);
  } catch {
    /* ignore */
  }
  start(id);
});

// A connection requested by the desktop app's main window starts by itself.
if (desktop?.params) {
  const p = desktop.params;
  $('id').value = String(p.id ?? '');
  $('password').value = String(p.password ?? '');
  $('label').value = String(p.label ?? '');
  form.elements.mode.value = p.mode === 'view' ? 'view' : 'control';
  form.hidden = true; // nothing to fill in: the main window already asked
  queueMicrotask(() => form.requestSubmit());
}

function start(id) {
  finished = false;
  active = false;
  challenge = null;
  cancelCountdown();
  $('endedActions').hidden = true;
  $('beacon').hidden = false;
  mode = form.elements.mode.value === 'view' ? 'view' : 'control';
  e2e = new ViewerE2E({ id, password: $('password').value });
  chat.start({ sendJson: sendSecure });
  assistant.start({ sendJson: sendSecure });
  extras.start({
    sendJson: sendSecure,
    sendChunk: (tid, last, bytes) => sendSecureKind(KIND_FILE, packFileBody(tid, last, bytes)),
    bufferedAmount: () => (ws ? ws.bufferedAmount : 0),
  });
  $('go').disabled = true;
  setStatus('Connexion au serveur…');

  ws = new WebSocket(relayUrl());
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => sendPlain({ t: 'viewer' });
  ws.onmessage = (ev) => {
    const handler = typeof ev.data === 'string' ? onText(ev.data, id) : onSecure(new Uint8Array(ev.data));
    handler.catch((err) => finish(`Erreur : ${err.message}`, true));
  };
  ws.onclose = () => finish(active ? 'Connexion terminée.' : 'Connexion au serveur interrompue.', !active);
  ws.onerror = () => finish('Impossible de joindre le serveur.', true);
}

async function onText(text, id) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.srv) {
    if (msg.srv === 'ready') sendPlain({ t: 'connect', id });
    else if (msg.srv === 'paired') setStatus('En attente de l’ordinateur distant…');
    else if (msg.srv === 'error') finish(ERRORS[msg.code] ?? `Erreur serveur : ${msg.code}`, true);
    else if (msg.srv === 'ended') finish(ENDED[msg.reason] ?? 'Session terminée.', msg.reason === 'host-offline');
    return;
  }
  switch (msg.t) {
    case 'challenge':
      if (msg.v !== 2) return finish('Version de protocole incompatible : mettez l’agent à jour.', true);
      challenge = msg;
      setStatus('Établissement de la connexion chiffrée…');
      sendPlain(await e2e.commitMessage());
      break;
    case 'hello-key': {
      if (!challenge || typeof msg.hpub !== 'string') return;
      const codecs = await supportedCodecs();
      const auth = await e2e.authMessage({ challenge, hpub: msg.hpub, mode, label: $('label').value, codecs });
      sendPlain(auth);
      if (e2e.usedPassword) setStatus('Vérification du mot de passe…');
      else setStatus(`Code de vérification : ${spaced(e2e.sas)}. La personne en face doit voir le même code avant d’accepter.`);
      break;
    }
    case 'denied': // plaintext denial (before keys exist, or a bad password)
      finish(DENIED[msg.reason] ?? 'Connexion refusée.', true);
      break;
    default:
  }
}

const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;

async function onSecure(packet) {
  if (!e2e?.channel) return;
  let opened;
  try {
    opened = await e2e.channel.open(packet);
  } catch {
    return finish('Flux chiffré invalide ou altéré : session interrompue par sécurité.', true);
  }
  if (opened.kind === KIND_FRAME) {
    const { width, height, jpeg } = unpackFrameBody(opened.body);
    return onFrame(jpeg, width, height);
  }
  if (opened.kind === KIND_VIDEO) return onVideo(unpackVideoBody(opened.body));
  if (opened.kind === KIND_FILE) return extras.onFileChunk(unpackFileBody(opened.body));
  if (opened.kind !== KIND_JSON) return;
  const msg = parseJsonBody(opened.body);
  switch (msg.t) {
    case 'waiting-consent':
      if (e2e.usedPassword) setStatus('En attente de l’accord de la personne en face…');
      else setStatus(`Code de vérification : ${spaced(e2e.sas)}. En attente de l’accord de la personne en face…`);
      break;
    case 'accepted':
      active = true;
      mode = msg.mode === 'control' ? 'control' : 'view';
      $('barStatus').textContent = mode === 'control' ? 'Contrôle à distance' : 'Lecture seule';
      $('barDetail').textContent = e2e.usedPassword ? '' : `Code ${spaced(e2e.sas)}`;
      $('beacon').hidden = true;
      hostPointer = true; // as before, unless the host says its pointer is not in the picture
      applyPointer();
      showStage(true);
      break;
    case 'denied':
      finish(DENIED[msg.reason] ?? 'Connexion refusée.', true);
      break;
    case 'bye':
      finish('La session a été terminée par l’ordinateur distant.');
      break;
    case 'monitors':
      showMonitors(msg);
      break;
    case 'secure':
      // lock / logon screen or UAC prompt that the host's program may not display
      $('secureNote').hidden = msg.on !== true;
      break;
    case 'pointer':
      // the host's pointer is in the picture: hide ours; otherwise show our own small marker
      hostPointer = msg.drawn === true;
      applyPointer();
      break;
    default:
      if (assistant.onJson(msg)) break; // Heimdall's answers from the host (and its permission)
      if (!chat.onJson(msg)) extras.onJson(msg); // chat; perm, clip, fs-*
  }
}

// --- remote displays --------------------------------------------------------------------
const monitorSel = $('monitorSel');

/** The host lists its displays (primary first): a chooser appears when there are several. */
function showMonitors(msg) {
  const list = Array.isArray(msg.list) ? msg.list.slice(0, 16) : [];
  const valid = list.every((m) => m && Number.isInteger(m.w) && Number.isInteger(m.h));
  if (!valid || list.length < 2) {
    monitorSel.hidden = true;
    monitorSel.replaceChildren();
    return;
  }
  const current = Number.isInteger(msg.current) && msg.current >= 0 && msg.current < list.length ? msg.current : 0;
  monitorSel.replaceChildren(
    ...list.map((m, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `Écran ${i + 1}${m.primary ? ' (principal)' : ''} · ${m.w}×${m.h}`;
      return option;
    }),
  );
  monitorSel.value = String(current);
  monitorSel.hidden = false;
}

monitorSel.addEventListener('change', () => {
  const i = Number(monitorSel.value);
  if (Number.isInteger(i) && i >= 0) sendSecure({ t: 'mon', i });
  canvas.focus(); // keep the keyboard going to the remote machine
});

function finish(text, isError = false) {
  if (finished) return;
  finished = true;
  const wasActive = active;
  // Each step is isolated: one failing cleanup must never leave the window stuck on the stage.
  const safely = (fn) => {
    try {
      fn();
    } catch {
      /* keep going */
    }
  };
  safely(releaseAll);
  safely(closeDecoder);
  safely(() => extras.stop());
  safely(() => chat.stop());
  safely(() => assistant.stop());
  safely(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  });
  monitorSel.hidden = true;
  monitorSel.replaceChildren();
  active = false;
  canvas.classList.remove('remote-pointer', 'local-pointer');
  $('secureNote').hidden = true;
  $('beacon').hidden = true;
  showStage(false);
  $('go').disabled = false;
  $('password').value = '';
  if (text) setStatus(text, isError);
  if (desktop) {
    // The connection form is hidden in the desktop app (the main window already asked).
    $('endedActions').hidden = false;
    if (wasActive && !isError) {
      $('again').hidden = false;
      startCountdown(8);
    } else {
      form.hidden = false; // wrong password, host offline...: another try right here
      $('again').hidden = true;
    }
  }
  const socket = ws;
  ws = null;
  e2e = null;
  if (socket) {
    socket.onclose = socket.onerror = socket.onmessage = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

$('stop').addEventListener('click', () => {
  sendPlain({ t: 'leave' });
  finish('Déconnecté.');
});
$('fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('stage').requestFullscreen?.();
});

// --- H.264 (WebCodecs) ------------------------------------------------------------------
let decoder = null;
let decoderCodec = '';
let decoderSize = '';
let awaitingKey = true;
let timestamp = 0;
let lastKeyRequest = 0;
let h264Support; // undefined until probed

/** Codecs this browser can decode, in order of preference. */
async function supportedCodecs() {
  if (h264Support === undefined) {
    h264Support = false;
    try {
      if (typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function') {
        const probe = await VideoDecoder.isConfigSupported({
          codec: 'avc1.4d401f',
          avc: { format: 'annexb' },
          optimizeForLatency: true,
        });
        h264Support = Boolean(probe.supported);
      }
    } catch {
      h264Support = false;
    }
  }
  return h264Support ? ['h264', 'jpeg'] : ['jpeg'];
}

function closeDecoder() {
  if (decoder && decoder.state !== 'closed') {
    try {
      decoder.close();
    } catch {
      /* already closed */
    }
  }
  decoder = null;
  decoderCodec = '';
  decoderSize = '';
  awaitingKey = true;
}

function requestKeyframe() {
  const now = performance.now();
  if (now - lastKeyRequest < 500) return;
  lastKeyRequest = now;
  sendSecure({ t: 'key' });
}

let decoderErrors = 0;

/** The browser claimed H.264 but cannot decode this stream: ask the host for JPEG instead. */
function fallBackToJpeg() {
  h264Support = false;
  closeDecoder();
  sendSecure({ t: 'codec', codec: 'jpeg' });
}

function configureDecoder(codec, width, height) {
  closeDecoder();
  decoder = new VideoDecoder({
    output: (frame) => {
      decoderErrors = 0;
      try {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
      } finally {
        frame.close();
      }
    },
    error: () => {
      // Lost sync (corrupt or missing data): start over from the next keyframe. Repeated
      // failures without a single decoded frame mean this stream is not decodable here.
      decoderErrors += 1;
      closeDecoder();
      if (decoderErrors >= 3) fallBackToJpeg();
      else requestKeyframe();
    },
  });
  decoder.configure({ codec, avc: { format: 'annexb' }, optimizeForLatency: true });
  decoderCodec = codec;
  decoderSize = `${width}x${height}`;
  awaitingKey = true;
}

function onVideo({ key, width, height, data }) {
  if (!h264Support) return;
  if (key) {
    const codec = codecStringFromAnnexB(data);
    if (!codec) return;
    // New codec parameters or a new resolution: a fresh decoder, keyframe first.
    if (!decoder || decoder.state === 'closed' || codec !== decoderCodec || `${width}x${height}` !== decoderSize) {
      configureDecoder(codec, width, height);
    }
    awaitingKey = false;
  } else if (!decoder || awaitingKey) {
    requestKeyframe();
    return;
  } else if (decoder.decodeQueueSize > 10) {
    // The decoder cannot keep up: skipping a delta frame breaks the chain, so resync.
    awaitingKey = true;
    requestKeyframe();
    return;
  }
  try {
    timestamp += 33_333;
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data }));
  } catch {
    decoderErrors += 1;
    closeDecoder();
    if (decoderErrors >= 3) fallBackToJpeg();
    else requestKeyframe();
  }
}

// --- JPEG fallback ----------------------------------------------------------------------
let latest = null;
let decoding = false;

function onFrame(jpeg, width, height) {
  latest = { blob: new Blob([jpeg], { type: 'image/jpeg' }), width, height };
  if (!decoding) drain();
}

async function drain() {
  decoding = true;
  while (latest) {
    const f = latest;
    latest = null;
    try {
      const bmp = await createImageBitmap(f.blob);
      if (canvas.width !== f.width || canvas.height !== f.height) {
        canvas.width = f.width;
        canvas.height = f.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    } catch {
      /* corrupt frame: skip */
    }
  }
  decoding = false;
}

// --- input ------------------------------------------------------------------------------
// Input events are sent in order through one promise chain: a remote paste first has to push the
// local clipboard (an asynchronous read) before the Ctrl+V that uses it.
let inputQueue = Promise.resolve();
function sendInput(msg) {
  inputQueue = inputQueue.then(() => sendSecure(msg));
}

const pendingMods = new Set(); // pressed locally, not yet sent (lazy: see keydown)
const sentMods = new Set();
const heldKeys = new Set();
const heldButtons = new Set();
let moveQueued = null;

const canInput = () => active && mode === 'control';

// While controlling, the host's own pointer is drawn into the video: hide ours so there is one
// pointer, not two. When the host hides it (Windows does while typing, some programs always), the
// picture has none: show a small ring of ours at the position being sent, so it never vanishes.
let hostPointer = true;
function applyPointer() {
  const control = active && mode === 'control';
  canvas.classList.toggle('remote-pointer', control && hostPointer);
  canvas.classList.toggle('local-pointer', control && !hostPointer);
}

function norm(e) {
  const r = canvas.getBoundingClientRect();
  // The canvas is letterboxed (object-fit: contain): map into the drawn image area.
  const scale = Math.min(r.width / canvas.width, r.height / canvas.height) || 1;
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  const x = (e.clientX - r.left - (r.width - w) / 2) / w;
  const y = (e.clientY - r.top - (r.height - h) / 2) / h;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

// Modifiers are held back until a non-text key or a click needs them, so that AltGr
// (reported as Ctrl+Alt) never turns a typed "@" into a Ctrl+Alt shortcut remotely.
function flushMods() {
  for (const code of pendingMods) {
    sendInput({ t: 'kd', code });
    sentMods.add(code);
  }
  pendingMods.clear();
}

function releaseAll() {
  if (ws && active) {
    for (const code of heldKeys) sendInput({ t: 'ku', code });
    for (const code of sentMods) sendInput({ t: 'ku', code });
    for (const b of heldButtons) sendInput({ t: 'mu', b });
  }
  pendingMods.clear();
  sentMods.clear();
  heldKeys.clear();
  heldButtons.clear();
}

canvas.addEventListener('mousemove', (e) => {
  if (!canInput() || moveQueued) return;
  moveQueued = requestAnimationFrame(() => {
    moveQueued = null;
    sendInput({ t: 'mv', ...norm(e) });
  });
});
canvas.addEventListener('mousedown', (e) => {
  if (!canInput()) return;
  const b = BUTTONS[e.button];
  if (!b) return;
  e.preventDefault();
  canvas.focus();
  flushMods();
  heldButtons.add(b);
  sendInput({ t: 'md', b, ...norm(e) });
});
window.addEventListener('mouseup', (e) => {
  if (!canInput()) return;
  const b = BUTTONS[e.button];
  if (!b || !heldButtons.delete(b)) return;
  sendInput({ t: 'mu', b, ...norm(e) });
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener(
  'wheel',
  (e) => {
    if (!canInput()) return;
    e.preventDefault();
    flushMods();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1; // lines/pages -> px
    sendInput({
      t: 'wh',
      dx: Math.round((e.deltaX * unit) / 100 * 120),
      dy: Math.round((-e.deltaY * unit) / 100 * 120),
    });
  },
  { passive: false },
);

const isTypedText = (e) =>
  e.key.length >= 1 &&
  [...e.key].length === 1 &&
  !e.metaKey &&
  ((!e.ctrlKey && !e.altKey) || e.getModifierState('AltGraph'));

window.addEventListener('keydown', (e) => {
  if (!canInput() || document.activeElement !== canvas) return;
  e.preventDefault();
  if (MODS.has(e.code)) {
    if (!sentMods.has(e.code)) pendingMods.add(e.code);
    return;
  }
  if (isTypedText(e)) {
    sendInput({ t: 'tx', ch: e.key });
    return;
  }
  if (e.ctrlKey && !e.altKey && e.code === 'KeyV') {
    // Remote paste: hand the local clipboard to the host first, and wait until it is in place,
    // so that the Ctrl+V pastes what the user copied here.
    inputQueue = inputQueue.then(async () => {
      const text = await extras.localClipboardForPaste();
      if (!text) return;
      sendSecure({ t: 'clip', text });
      await extras.waitClipboardAck();
    });
  }
  flushMods();
  heldKeys.add(e.code);
  sendInput({ t: 'kd', code: e.code });
});
window.addEventListener('keyup', (e) => {
  if (!canInput() || document.activeElement !== canvas) return;
  e.preventDefault();
  if (MODS.has(e.code)) {
    if (pendingMods.delete(e.code)) return;
    if (sentMods.delete(e.code)) sendInput({ t: 'ku', code: e.code });
    return;
  }
  if (heldKeys.delete(e.code)) sendInput({ t: 'ku', code: e.code });
});
canvas.addEventListener('blur', releaseAll);
