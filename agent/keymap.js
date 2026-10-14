// KeyboardEvent.code -> [Set-1 scancode, extended flag].
// Physical-key based, so the host's own layout decides the produced character.
// Printable characters typed without Ctrl/Alt/Meta travel as text instead (see viewer).

const T = {};
const add = (code, scan, ext = 0) => {
  T[code] = [scan, ext];
};

const letters = 'QWERTYUIOP';
[...letters].forEach((c, i) => add(`Key${c}`, 0x10 + i));
[...'ASDFGHJKL'].forEach((c, i) => add(`Key${c}`, 0x1e + i));
[...'ZXCVBNM'].forEach((c, i) => add(`Key${c}`, 0x2c + i));
[...'1234567890'].forEach((c, i) => add(`Digit${c}`, 0x02 + i));
for (let i = 1; i <= 10; i++) add(`F${i}`, 0x3a + i);
add('F11', 0x57);
add('F12', 0x58);

add('Escape', 0x01);
add('Minus', 0x0c);
add('Equal', 0x0d);
add('Backspace', 0x0e);
add('Tab', 0x0f);
add('BracketLeft', 0x1a);
add('BracketRight', 0x1b);
add('Enter', 0x1c);
add('ControlLeft', 0x1d);
add('Semicolon', 0x27);
add('Quote', 0x28);
add('Backquote', 0x29);
add('ShiftLeft', 0x2a);
add('Backslash', 0x2b);
add('Comma', 0x33);
add('Period', 0x34);
add('Slash', 0x35);
add('ShiftRight', 0x36);
add('NumpadMultiply', 0x37);
add('AltLeft', 0x38);
add('Space', 0x39);
add('CapsLock', 0x3a);
add('NumLock', 0x45);
add('ScrollLock', 0x46);
add('IntlBackslash', 0x56);

[...'789'].forEach((c, i) => add(`Numpad${c}`, 0x47 + i));
add('NumpadSubtract', 0x4a);
[...'456'].forEach((c, i) => add(`Numpad${c}`, 0x4b + i));
add('NumpadAdd', 0x4e);
[...'123'].forEach((c, i) => add(`Numpad${c}`, 0x4f + i));
add('Numpad0', 0x52);
add('NumpadDecimal', 0x53);

// Extended keys (E0 prefix)
add('NumpadEnter', 0x1c, 1);
add('ControlRight', 0x1d, 1);
add('NumpadDivide', 0x35, 1);
add('AltRight', 0x38, 1);
add('Home', 0x47, 1);
add('ArrowUp', 0x48, 1);
add('PageUp', 0x49, 1);
add('ArrowLeft', 0x4b, 1);
add('ArrowRight', 0x4d, 1);
add('End', 0x4f, 1);
add('ArrowDown', 0x50, 1);
add('PageDown', 0x51, 1);
add('Insert', 0x52, 1);
add('Delete', 0x53, 1);
add('MetaLeft', 0x5b, 1);
add('MetaRight', 0x5c, 1);
add('ContextMenu', 0x5d, 1);

export const KEYMAP = Object.freeze(T);

export function lookupKey(code) {
  return typeof code === 'string' && Object.hasOwn(KEYMAP, code) ? KEYMAP[code] : null;
}
