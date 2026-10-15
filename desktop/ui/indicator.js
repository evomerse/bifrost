const { init, stop } = window.bifrostIndicator;

init().then((data) => {
  if (!data) return;
  const who = [data.name, data.peer].filter(Boolean).join(' · ');
  if (who) {
    // structured data from the session: a short title, and who is looking underneath
    document.getElementById('text').textContent = 'Votre écran est partagé';
    const detail = document.getElementById('detail');
    detail.textContent = data.mode === 'view' ? `${who} · lecture seule` : who;
  } else {
    document.getElementById('text').textContent = data.text;
  }
  document.getElementById('stop').textContent = data.stopLabel;
});
document.getElementById('stop').addEventListener('click', () => stop());
