// Heimdall inside a remote session (desktop app only). The technician talks to the assistant here;
// its tools run on the computer being controlled: each call is sent to the host over the same
// end-to-end encrypted channel as everything else, and the answer comes back the same way.
// In a plain browser there is no assistant: the button never shows.

const MAX_CHARS = 4000;
const RESULT_TIMEOUT_MS = 190_000; // a little under the main process' own limit

/**
 * Created once. start(io) binds it to a session, stop() unbinds it.
 *   io = { sendJson(obj) }
 */
export function createAssistant($, desktop) {
  const api = desktop?.heimdall ?? null;
  const el = {
    button: $('aiBtn'),
    panel: $('aiPanel'),
    log: $('aiLog'),
    form: $('aiForm'),
    input: $('aiInput'),
    send: $('aiSend'),
    close: $('aiClose'),
    reset: $('aiReset'),
    note: $('aiNote'),
    error: $('aiError'),
    screen: $('screen'),
  };

  let io = null;
  let available = false;
  let remote = 'old'; // 'on' | 'off' (the owner refuses it) | 'old' (this host does not know the assistant)
  let busy = false;
  const waiting = new Map(); // request id -> { resolve, timer }

  function setOpen(open) {
    el.panel.hidden = !open;
    el.button.setAttribute('aria-expanded', String(open));
    if (open) {
      // one floating window at a time at the bottom right
      if (!$('talkPanel').hidden) $('talkClose').click();
      refreshNote();
      el.input.focus();
    } else {
      el.screen.focus(); // the keyboard goes back to the remote computer
    }
  }

  async function refreshNote() {
    let note = '';
    if (remote === 'old') {
      note = 'Cet ordinateur distant n’a pas une version de Bifrost qui propose l’assistant : mettez-y la même version que la vôtre (Réglages, mises à jour). En attendant, c’est son propre Heimdall qu’on voit sur son écran.';
    } else if (remote === 'off') {
      note = 'Le propriétaire de cet ordinateur n’autorise pas l’assistant (Autorisations de son Bifrost).';
    }
    if (note) {
      el.note.textContent = note;
      el.note.hidden = false;
      return;
    }
    try {
      const st = await api.state();
      if (!st.enabled) note = 'Heimdall est désactivé sur votre Bifrost : activez-le dans les Réglages (fenêtre principale).';
      else if (!st.hasKey) note = `Aucune clé API enregistrée pour ${st.provider} : ajoutez-la dans les Réglages (fenêtre principale).`;
    } catch {
      /* keep the panel usable: the request itself will report the problem */
    }
    el.note.textContent = note;
    el.note.hidden = !note;
  }

  function addMessage(kind, text, extra = '') {
    el.log.querySelector('.empty')?.remove();
    const div = document.createElement('div');
    div.className = `msg ${kind} ${extra}`.trim();
    div.textContent = text;
    el.log.append(div);
    el.log.scrollTop = el.log.scrollHeight;
    return div;
  }

  function addStep(step) {
    el.log.querySelector('.empty')?.remove();
    const div = document.createElement('div');
    div.className = `step ${step.status === 'done' ? '' : step.status}`.trim();
    const title = document.createElement('div');
    const arg = step.args?.command ? ` : ${step.args.command}` : '';
    title.textContent = `${step.status === 'denied' ? '⛔' : step.status === 'error' ? '⚠️' : '⚙️'} ${step.name}${arg}`;
    div.append(title);
    if (step.output) {
      const pre = document.createElement('pre');
      pre.textContent = step.output;
      div.append(pre);
    }
    el.log.append(div);
  }

  function clearLog() {
    const empty = document.createElement('p');
    empty.className = 'empty muted';
    empty.textContent = 'Demandez par exemple : « combien d’espace reste-t-il sur les disques ? », « qu’est-ce qui ralentit ce PC ? », « vide la corbeille ».';
    el.log.replaceChildren(empty);
  }

  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  /** The main process wants a tool run on the host: forward it, and give the answer back. */
  function runOnHost({ reqId, name, args }) {
    if (!io || !available) {
      api.result(reqId, 'La session distante n’est plus active.');
      return;
    }
    const id = `${Date.now().toString(36)}-${reqId}`;
    const timer = setTimeout(() => {
      waiting.delete(id);
      api.result(reqId, 'L’ordinateur distant n’a pas répondu (délai dépassé).');
    }, RESULT_TIMEOUT_MS);
    waiting.set(id, {
      resolve: (output) => {
        clearTimeout(timer);
        api.result(reqId, output);
      },
      timer,
    });
    io.sendJson({ t: 'hd-run', id, name, args });
  }

  el.button.addEventListener('click', () => setOpen(el.panel.hidden));
  el.close.addEventListener('click', () => setOpen(false));
  // opening the conversation with the person closes this window (see setOpen the other way round)
  $('talkBtn').addEventListener('click', () => {
    if (!$('talkPanel').hidden && !el.panel.hidden) setOpen(false);
  });
  el.panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  });
  el.reset.addEventListener('click', async () => {
    try {
      await api?.reset();
    } catch {
      /* nothing to reset */
    }
    clearLog();
    showError('');
  });
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el.input.value.trim().slice(0, MAX_CHARS);
    if (!text || busy || !io || !available) return;
    busy = true;
    el.input.value = '';
    el.send.disabled = true;
    showError('');
    el.log.querySelector('.empty')?.remove();
    addMessage('user', text);
    const pending = addMessage('bot', 'Heimdall réfléchit…', 'pending');
    try {
      const r = await api.ask(text);
      pending.remove();
      for (const step of r.steps) addStep(step);
      addMessage('bot', r.reply);
    } catch (err) {
      pending.remove();
      showError(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      busy = false;
      el.send.disabled = false;
      el.input.focus();
      el.log.scrollTop = el.log.scrollHeight;
    }
  });

  return {
    start(handlers) {
      io = handlers;
      available = false;
      remote = 'old';
      busy = false;
      clearLog();
      showError('');
      if (api) api.onRun(runOnHost);
    },

    /** The session is over: the conversation and any call still waiting go with it. */
    stop() {
      io = null;
      available = false;
      for (const w of waiting.values()) clearTimeout(w.timer);
      waiting.clear();
      el.button.hidden = true;
      el.panel.hidden = true;
      el.button.setAttribute('aria-expanded', 'false');
      el.input.value = '';
      clearLog();
      showError('');
      api?.setRemote(null).catch(() => {});
    },

    /**
     * Decrypted JSON from the host. 'perm' tells whether the assistant is offered (it is read here
     * and left to the other handlers: returns false); 'hd-result' is consumed (returns true).
     */
    onJson(msg) {
      if (!io || !api) return false;
      if (msg.t === 'perm') {
        const platform = msg.assistant?.platform;
        available = ['win32', 'darwin', 'linux'].includes(platform);
        remote = available ? 'on' : msg.assistant === false ? 'off' : 'old';
        // always offered while controlling (desktop app): when it cannot work, the panel says why
        el.button.hidden = io.isControl ? !io.isControl() : false;
        el.input.disabled = !available;
        el.send.disabled = !available || busy;
        if (available) api.setRemote({ platform }).catch(() => {});
        if (!el.panel.hidden) refreshNote();
        return false;
      }
      if (msg.t === 'hd-result') {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const w = waiting.get(id);
        if (w) {
          waiting.delete(id);
          w.resolve(typeof msg.output === 'string' ? msg.output : '');
        }
        return true;
      }
      return false;
    },
  };
}
