// Heimdall: the conversation loop. Sends the history to the chosen provider, executes the tools
// the model asks for (after the person's confirmation when they change something), and goes on
// until the model answers in plain text.
import { spawn } from 'node:child_process';
import { PROVIDERS, buildRequest, parseResponse, parseTextToolCall, providerInfo, textProtocolPrompt } from './providers.js';
import { createTools } from './tools.js';

const MAX_ROUNDS = 6;
const MAX_HISTORY = 40;
const REQUEST_TIMEOUT_MS = 60_000;

const SYSTEM =
  'Tu es Heimdall, le gardien du Bifrost : l’assistant intégré à l’application Bifrost (prise en main à distance). ' +
  'Tu aides la personne devant cet ordinateur à le surveiller et à l’entretenir, en français, de façon brève et claire. ' +
  'Tu peux agir sur cet ordinateur uniquement avec les outils fournis. N’invente jamais le résultat d’un outil : ' +
  'appelle-le, puis résume ce qu’il a renvoyé. Si une action est refusée par la personne, accepte-le sans insister. ' +
  'N’utilise run_command que si aucun autre outil ne convient.';

/** Asks the `claude` command line tool (Claude Code) one question, no API key involved. */
export function runClaudeCode(prompt, { spawnFn = spawn, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // -p: print the answer and exit. The prompt goes through stdin (no quoting problems).
      child = spawnFn('claude', ['-p', '--output-format', 'text'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    } catch (err) {
      reject(new Error(`Claude Code est introuvable (${err.message}).`));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude Code ne répond pas (délai dépassé).'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? 'Claude Code (commande « claude ») n’est pas installé sur ce PC.' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error((err || out || `Claude Code s’est arrêté (code ${code}).`).trim().slice(0, 400)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/**
 * @param {object} o
 * @param {() => {provider:string, model:string, apiKey:string}} o.getConfig
 * @param {(text:string)=>Promise<boolean>} o.confirm      native confirmation dialog
 * @param {typeof fetch} [o.fetchFn]
 * @param {ReturnType<typeof createTools>} [o.tools]
 * @param {(prompt:string)=>Promise<string>} [o.claudeCode]
 */
export function createHeimdall({ getConfig, confirm, fetchFn = fetch, tools = createTools(), claudeCode = runClaudeCode, log = () => {} }) {
  let history = [];

  async function callApi(cfg, definitions) {
    const provider = providerInfo(cfg.provider);
    if (!cfg.apiKey) throw new Error(`Aucune clé API enregistrée pour ${provider.label}.`);
    const { url, headers, body } = buildRequest(provider, {
      model: cfg.model,
      apiKey: cfg.apiKey,
      system: SYSTEM,
      messages: history,
      tools: definitions,
    });
    const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error('Clé API refusée par le fournisseur : vérifiez-la dans les paramètres.');
      if (res.status === 429) throw new Error('Limite de requêtes atteinte chez le fournisseur : réessayez dans un instant.');
      const detail = json?.error?.message ?? json?.error ?? res.statusText;
      throw new Error(`Erreur du fournisseur (${res.status}) : ${String(detail).slice(0, 300)}`);
    }
    return parseResponse(provider, json);
  }

  async function callClaudeCode(definitions) {
    const convo = history
      .map((m) => {
        if (m.role === 'user') return `Utilisateur : ${m.text}`;
        if (m.role === 'assistant') return `Heimdall : ${m.text || JSON.stringify({ tool: m.toolCalls?.[0]?.name, args: m.toolCalls?.[0]?.args })}`;
        return `Résultat de l’outil ${m.name} : ${m.text}`;
      })
      .join('\n\n');
    const text = await claudeCode(`${SYSTEM}\n\n${textProtocolPrompt(definitions)}\n\n${convo}\n\nHeimdall :`);
    const call = parseTextToolCall(text);
    return call ? { text: '', toolCalls: [call] } : { text, toolCalls: [] };
  }

  return {
    providers: PROVIDERS,

    reset() {
      history = [];
    },

    /**
     * One user turn. Returns { reply, steps }, steps being what was done on the way:
     * [{ name, args, status: 'done'|'denied'|'error', output }]
     */
    async ask(text) {
      const cfg = getConfig();
      const provider = providerInfo(cfg.provider);
      const definitions = tools.definitions();
      history.push({ role: 'user', text: String(text).slice(0, 4000) });
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      const steps = [];

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const turn = provider.kind === 'claude-code' ? await callClaudeCode(definitions) : await callApi(cfg, definitions);
        history.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });
        if (!turn.toolCalls.length) return { reply: turn.text || '…', steps };

        for (const call of turn.toolCalls) {
          const tool = tools.get(call.name);
          const step = { name: call.name, args: call.args, status: 'done', output: '' };
          if (!tool) {
            step.status = 'error';
            step.output = `Outil inconnu : ${call.name}`;
          } else {
            const ask = tool.confirm?.(call.args);
            const allowed = ask ? await confirm(ask) : true;
            if (!allowed) {
              step.status = 'denied';
              step.output = 'La personne a refusé cette action.';
            } else {
              try {
                step.output = String(await tool.run(call.args ?? {}));
              } catch (err) {
                step.status = 'error';
                step.output = `Erreur : ${err.message}`;
              }
            }
          }
          log(`heimdall: ${call.name} -> ${step.status}`);
          steps.push(step);
          history.push({ role: 'tool', id: call.id, name: call.name, text: step.output });
        }
      }
      return { reply: 'J’ai atteint le nombre maximal d’étapes pour cette demande. Dites-moi si je dois continuer.', steps };
    },
  };
}
