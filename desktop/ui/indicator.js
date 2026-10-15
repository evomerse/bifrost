// The session box: stays on top at the bottom right of the shared PC, like TeamViewer's.
// Folded, it is a slim bar (who is connected, Stop); a message from the other side unfolds it.
const box = window.bifrostBox;
const $ = (id) => document.getElementById(id);

let rendered = 0; // messages already drawn
let seen = 0; // messages the person has had on screen
let open = false;
let list = [];

function renderBadge() {
  const unread = open ? 0 : list.slice(seen).filter((m) => m.from === 'peer').length;
  $('badge').hidden = unread === 0;
  $('badge').textContent = unread > 9 ? '9+' : String(unread);
}

function setOpen(on) {
  open = on;
  $('boxChat').hidden = !on;
  $('chatToggle').setAttribute('aria-expanded', String(on));
  if (on) {
    seen = list.length;
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
  }
  renderBadge();
}

function render(messages) {
  list = Array.isArray(messages) ? messages : [];
  const log = $('chatLog');
  if (list.length < rendered) {
    log.replaceChildren(); // a new session: start from nothing
    rendered = 0;
    seen = 0;
  }
  if (rendered === 0 && list.length === 0 && !log.querySelector('.empty')) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Aucun message pour l’instant.';
    log.replaceChildren(p);
  }
  if (list.length > rendered) {
    log.querySelector('.empty')?.remove();
    for (const m of list.slice(rendered)) {
      const div = document.createElement('div');
      div.className = `msg ${m.from === 'me' ? 'me' : m.from === 'system' ? 'sys' : 'peer'}`;
      div.textContent = m.text;
      log.append(div);
    }
    rendered = list.length;
    log.scrollTop = log.scrollHeight;
  }
  if (open) seen = list.length;
  renderBadge();
}

box.init().then((data) => {
  if (!data) return;
  const who = [data.name, data.peer].filter(Boolean).join(' · ');
  if (who) {
    // structured data from the session: a short title, and who is looking underneath
    $('text').textContent = 'Votre écran est partagé';
    $('detail').textContent = data.mode === 'view' ? `${who} · lecture seule` : who;
  } else {
    $('text').textContent = data.text;
  }
  $('stop').textContent = data.stopLabel;
  $('chatToggle').hidden = !data.chat;
  render(data.messages);
  setOpen(data.open === true);
});

box.onMessages(render);
// the main process unfolds the box when someone writes, and resizes the window with it
box.onOpen((on) => {
  setOpen(on);
  if (on) $('chatLog').scrollTop = $('chatLog').scrollHeight;
});

$('chatToggle').addEventListener('click', () => {
  const next = !open;
  setOpen(next);
  box.setOpen(next);
  if (next) $('chatInput').focus();
});
$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  try {
    await box.send(text);
    $('chatInput').value = '';
  } catch {
    /* no session any more: the box is about to close */
  }
  $('chatInput').focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open) {
    setOpen(false);
    box.setOpen(false);
  }
});
$('stop').addEventListener('click', () => box.stop());
