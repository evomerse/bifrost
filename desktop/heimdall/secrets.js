// API keys of the assistant. Encrypted with the operating system's store (Electron safeStorage:
// DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). When no such store exists
// (a bare Linux session), the key is kept in the settings file as is, and the interface says so.

const ENC = 'enc:';
const RAW = 'raw:';

/** @param {{isEncryptionAvailable():boolean, encryptString(s:string):Buffer, decryptString(b:Buffer):string}} safeStorage */
export function createSecretStore(safeStorage) {
  const encrypted = () => {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable());
    } catch {
      return false;
    }
  };
  return {
    get encrypted() {
      return encrypted();
    },
    seal(plain) {
      if (typeof plain !== 'string' || !plain) return '';
      return encrypted() ? ENC + safeStorage.encryptString(plain).toString('base64') : RAW + Buffer.from(plain, 'utf8').toString('base64');
    },
    open(stored) {
      if (typeof stored !== 'string' || !stored) return '';
      try {
        if (stored.startsWith(ENC)) return encrypted() ? safeStorage.decryptString(Buffer.from(stored.slice(ENC.length), 'base64')) : '';
        if (stored.startsWith(RAW)) return Buffer.from(stored.slice(RAW.length), 'base64').toString('utf8');
      } catch {
        /* undecryptable: the key has to be entered again */
      }
      return '';
    },
  };
}
