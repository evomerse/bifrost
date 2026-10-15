// What the relay serves to browsers, and what the desktop app serves to its own windows:
// URL path -> [file relative to the project root, content type]. A fixed list, nothing else
// is ever readable through it.
export const VIEWER_FILES = new Map([
  ['/', ['viewer/index.html', 'text/html; charset=utf-8']],
  ['/viewer.js', ['viewer/viewer.js', 'text/javascript; charset=utf-8']],
  ['/transfer.js', ['viewer/transfer.js', 'text/javascript; charset=utf-8']],
  ['/extras.js', ['viewer/extras.js', 'text/javascript; charset=utf-8']],
  ['/chat.js', ['viewer/chat.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['viewer/style.css', 'text/css; charset=utf-8']],
  ['/logo.png', ['viewer/logo.png', 'image/png']],
  ['/shared/auth.js', ['shared/auth.js', 'text/javascript; charset=utf-8']],
  ['/shared/e2e.js', ['shared/e2e.js', 'text/javascript; charset=utf-8']],
]);
