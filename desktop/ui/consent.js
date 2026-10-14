// Incoming-connection dialog. "Refuser" has the focus: a stray Enter never grants access.
const { init, answer } = window.bifrostConsent;

init().then((request) => {
  if (!request) return answer(false);
  document.title = request.title;
  document.getElementById('text').textContent = request.text;

  const bar = document.getElementById('bar');
  const start = Date.now();
  const timer = setInterval(() => {
    const left = Math.max(0, 1 - (Date.now() - start) / request.timeoutMs);
    bar.style.width = `${left * 100}%`;
    if (left === 0) {
      clearInterval(timer);
      answer(false);
    }
  }, 200);
  return undefined;
});

document.getElementById('allow').addEventListener('click', () => answer(true));
document.getElementById('deny').addEventListener('click', () => answer(false));
document.getElementById('deny').focus();
