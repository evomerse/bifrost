const { init, stop } = window.bifrostIndicator;

init().then((data) => {
  if (!data) return;
  document.getElementById('text').textContent = data.text;
  document.getElementById('stop').textContent = data.stopLabel;
});
document.getElementById('stop').addEventListener('click', () => stop());
