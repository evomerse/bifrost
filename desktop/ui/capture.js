// Hidden window: turns the shared screen into JPEG frames. Started by the main process.
const api = window.bifrostCapture;
const video = document.getElementById('v');
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });
let stream = null;
let timer = null;
let busy = false;

window.__bifrostCaptureStop = () => {
  clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
};

window.__bifrostCaptureStart = async ({ fps, maxWidth, quality }) => {
  window.__bifrostCaptureStop();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps, cursor: 'always' }, audio: false });
    video.srcObject = stream;
    await video.play();
  } catch (err) {
    api.failed(`capture refusée : ${err.message}`);
    return;
  }
  stream.getVideoTracks()[0]?.addEventListener('ended', () => api.failed('la capture s’est arrêtée'));
  timer = setInterval(() => {
    if (busy || !video.videoWidth) return;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const w = Math.max(2, Math.round(video.videoWidth * scale) & ~1);
    const h = Math.max(2, Math.round(video.videoHeight * scale) & ~1);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    busy = true;
    canvas.toBlob(
      async (blob) => {
        try {
          if (blob) api.frame(w, h, new Uint8Array(await blob.arrayBuffer()));
        } finally {
          busy = false;
        }
      },
      'image/jpeg',
      Math.min(0.95, Math.max(0.2, quality / 100)),
    );
  }, Math.round(1000 / Math.max(1, fps)));
};
