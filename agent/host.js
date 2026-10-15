import WebSocket from 'ws';
import { formatId } from '../shared/auth.js';
import { ensureIdentity, saveConfig } from './config.js';
import { describePermissions, buildPermissions } from './permissions.js';
import { PasswordGuard, Session } from './session.js';

/**
 * The host side of Bifrost: keeps this PC registered on the relay and runs a Session for every
 * person who connects. Used by the command-line agent, the Windows service and the desktop app.
 *
 * @param {object}   o
 * @param {object}   o.cfg          agent configuration (mutated in place: id, password key...)
 * @param {string}   o.cfgFile      where it is saved
 * @param {object}   o.helpers      OS helpers (capture, input, clipboard, consent dialog, indicator)
 * @param {boolean} [o.serviceMode] running as the SYSTEM service
 * @param {boolean} [o.chat]        offer the text chat (needs a UI listening to {type:'chat'} events)
 * @param {(m:string)=>void} [o.log]
 * @param {(e:object)=>void} [o.onEvent] status events for a UI:
 *     {type:'status', status:'connecting'|'online'|'offline', server, id}
 *     {type:'session', phase:'incoming'|'ended', ip?, reason?}
 *     {type:'chat', text, name}   a line typed by the person on the other side
 *     {type:'assistant', name, args, peer}   the other side's assistant runs a tool on this PC
 * @returns {{ stop(), reconnect(), endSession(reason?), sendChat(text), readonly status, readonly session }}
 */
export function startHost({ cfg, cfgFile, helpers, serviceMode = false, chat = false, log = () => {}, onEvent = () => {} }) {
  const guard = new PasswordGuard();
  let ws = null;
  let session = null;
  let backoff = 1000;
  let rerolls = 0;
  let status = 'connecting';
  let stopped = false;
  let retryTimer = null;

  const setStatus = (s) => {
    status = s;
    onEvent({ type: 'status', status: s, server: cfg.server, id: cfg.id });
  };

  const baseDir = cfgFile ? cfgFile.replace(/[\\/][^\\/]*$/, '') : undefined;

  const onServer = async (msg) => {
    switch (msg.srv) {
      case 'registered':
        log(`En ligne sur ${cfg.server}`);
        setStatus('online');
        break;
      case 'error':
        if (msg.code === 'id_taken' && rerolls < 5) {
          rerolls += 1;
          await ensureIdentity(cfg, { reroll: true });
          if (cfgFile) saveConfig(cfg, cfgFile);
          log(`Identifiant deja pris, nouveau : ${formatId(cfg.id)}`);
          onEvent({ type: 'status', status, server: cfg.server, id: cfg.id });
        } else log(`Erreur serveur : ${msg.code}`);
        break;
      case 'peer': {
        if (session) return;
        const sock = ws;
        const s = new Session({
          peerIp: String(msg.ip ?? 'inconnue').slice(0, 64),
          config: cfg,
          helpers,
          guard,
          log,
          permissions: buildPermissions(cfg, { serviceMode, baseDir, log }),
          send: (m) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(m)),
          sendBinary: (b) => sock.readyState === WebSocket.OPEN && sock.send(b, { binary: true }),
          bufferedAmount: () => sock.bufferedAmount,
          chat,
          onChat: chat ? (text, name) => onEvent({ type: 'chat', text, name }) : undefined,
          onAssistant: (a) => onEvent({ type: 'assistant', ...a }),
          onEnd: (reason) => {
            if (session === s) session = null;
            onEvent({ type: 'session', phase: 'ended', ip: s.peerIp, reason });
          },
        });
        session = s;
        log(`Demande de connexion depuis ${s.peerIp}`);
        onEvent({ type: 'session', phase: 'incoming', ip: s.peerIp });
        s.begin();
        break;
      }
      case 'peer-left':
        session?.end('viewer-left');
        break;
      default:
    }
  };

  const connect = () => {
    if (stopped) return;
    setStatus('connecting');
    const sock = new WebSocket(cfg.server, { maxPayload: 4 * 1024 * 1024 });
    ws = sock;

    sock.on('open', () => {
      backoff = 1000;
      sock.send(JSON.stringify({ t: 'host', id: cfg.id, secret: cfg.secret }));
    });

    sock.on('message', (data, isBinary) => {
      if (sock !== ws) return;
      if (isBinary) {
        session?.onBinary(data).catch((err) => log(`erreur session : ${err.message}`));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (typeof msg.srv === 'string') return onServer(msg);
      session?.onMessage(msg).catch((err) => log(`erreur session : ${err.message}`));
    });

    sock.on('close', () => {
      if (sock !== ws) return; // replaced by reconnect()
      session?.end('server-disconnected');
      session = null;
      if (stopped) return;
      setStatus('offline');
      log(`Deconnecte du serveur, nouvel essai dans ${Math.round(backoff / 1000)} s`);
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    sock.on('error', (err) => log(`Erreur reseau : ${err.message}`));
  };

  log(`Identifiant de ce PC : ${formatId(cfg.id)}${serviceMode ? ' (service)' : ''}`);
  log(
    cfg.passwordKey
      ? `Acces sans surveillance : mot de passe actif${cfg.requireConsent ? ' (accord demande quand meme)' : ''}`
      : "Aucun mot de passe : chaque connexion demandera l'accord de la personne devant le PC",
  );
  log(describePermissions(cfg, serviceMode, baseDir).split('\n').join(' | '));
  connect();

  return {
    get status() {
      return status;
    },
    get session() {
      return session;
    },

    /** Applies a changed server address / identity: drops the current link and registers again. */
    reconnect() {
      if (stopped) return;
      clearTimeout(retryTimer);
      session?.end('reconfigured', { notifyPeer: true, leave: true });
      session = null;
      const old = ws;
      ws = null;
      try {
        old?.close();
      } catch {
        /* already closed */
      }
      backoff = 1000;
      rerolls = 0;
      connect();
    },

    /** Sends a chat line to the person connected. False when there is no active session. */
    sendChat(text) {
      return session?.sendChat(text) ?? false;
    },

    /** Ends the running remote session, if any (the person at this PC clicked Stop). */
    endSession(reason = 'stopped-by-host') {
      session?.end(reason, { notifyPeer: true, leave: true });
    },

    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      session?.end('agent-exit', { notifyPeer: true, leave: true });
      const old = ws;
      ws = null;
      // give the farewell packets a moment to leave before closing
      setTimeout(() => {
        try {
          old?.close();
        } catch {
          /* already closed */
        }
      }, 150);
    },
  };
}
