// Text chat with the person at the other computer. Browser only (it touches the DOM).
// Messages travel on the same end-to-end encrypted channel as everything else and live in memory
// for one session: stop() wipes them, and nothing is written anywhere.

const MAX_CHARS = 2000;

/**
 * Created once. start(io) binds it to a session, stop() unbinds it and forgets the conversation.
 *   io = { sendJson(obj) }
 */
export function createChat($) {
  const el = {
    button: $('talkBtn'),
    badge: $('talkBadge'),
    panel: $('talkPanel'),
    log: $('talkLog'),
    form: $('talkForm'),
    input: $('talkInput'),
    close: $('talkClose'),
    screen: $('screen'),
  };

  let io = null;
  let available = false;
  let unread = 0;

  function renderBadge() {
    el.badge.hidden = unread === 0;
    el.badge.textContent = unread > 9 ? '9+' : String(unread);
  }

  function addLine(from, text) {
    el.log.querySelector('.empty')?.remove();
    const line = document.createElement('div');
    line.className = `msg ${from}`;
    line.textContent = text;
    el.log.append(line);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function clearLog() {
    const empty = document.createElement('p');
    empty.className = 'empty muted';
    empty.textContent = 'Aucun message pour l’instant.';
    el.log.replaceChildren(empty);
  }

  function setOpen(open) {
    el.panel.hidden = !open;
    el.button.setAttribute('aria-expanded', String(open));
    if (open) {
      unread = 0;
      renderBadge();
      el.input.focus();
    } else {
      el.screen.focus(); // the keyboard goes back to the remote computer
    }
  }

  el.button.addEventListener('click', () => setOpen(el.panel.hidden));
  el.close.addEventListener('click', () => setOpen(false));
  el.panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  });
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value.trim().slice(0, MAX_CHARS);
    if (!text || !io || !available) return;
    io.sendJson({ t: 'chat', text });
    addLine('me', text);
    el.input.value = '';
  });

  return {
    start(handlers) {
      io = handlers;
      available = false;
      unread = 0;
      clearLog();
      renderBadge();
    },

    /** The session is over: the conversation goes with it. */
    stop() {
      io = null;
      available = false;
      unread = 0;
      el.input.value = '';
      clearLog();
      renderBadge();
      el.button.hidden = true;
      el.panel.hidden = true;
      el.button.setAttribute('aria-expanded', 'false');
    },

    /**
     * Decrypted JSON from the host. 'perm' also carries what the host allows: it is read here and
     * left to the other handlers (returns false); 'chat' is consumed (returns true).
     */
    onJson(msg) {
      if (!io) return false;
      if (msg.t === 'perm') {
        available = msg.chat === true;
        el.button.hidden = !available;
        return false;
      }
      if (msg.t === 'chat') {
        if (!available || typeof msg.text !== 'string') return true;
        const text = msg.text.slice(0, MAX_CHARS);
        addLine('peer', text);
        if (el.panel.hidden) {
          unread += 1;
          renderBadge();
        }
        return true;
      }
      return false;
    },
  };
}
