// Heimdall: the AI providers. Pure request builders and response parsers (no network here), so
// they can be tested without keys. The conversation is kept in one neutral shape:
//
//   { role: 'user',      text }
//   { role: 'assistant', text, toolCalls: [{ id, name, args }] }
//   { role: 'tool',      id, name, text }                    (result of a tool call)
//
// and converted to each provider's wire format.

export const PROVIDERS = {
  groq: {
    id: 'groq',
    label: 'Groq Cloud (gratuit, recommandé)',
    kind: 'openai',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: 'gsk_',
  },
  openai: {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    kind: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4.1-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: 'sk-',
  },
  xai: {
    id: 'xai',
    label: 'Grok (xAI)',
    kind: 'openai',
    url: 'https://api.x.ai/v1/chat/completions',
    defaultModel: 'grok-4',
    keyUrl: 'https://console.x.ai/',
    keyPrefix: 'xai-',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: 'AIza',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: 'sk-ant-',
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code (programme « claude » installé sur ce PC, sans clé API)',
    kind: 'claude-code',
    defaultModel: '',
    keyUrl: 'https://docs.claude.com/en/docs/claude-code/overview',
    noKey: true,
  },
};

/** The only addresses the application opens in the browser on behalf of the settings page. */
export const EXTERNAL_LINKS = new Set([
  ...Object.values(PROVIDERS).map((p) => p.keyUrl),
  'https://console.groq.com/',
  'https://github.com/evomerse/bifrost',
]);

export function providerInfo(id) {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : PROVIDERS.groq;
}

const geminiSchema = (schema) => (schema && Object.keys(schema.properties ?? {}).length ? schema : undefined);

/** -> { url, headers, body } for one model call. `tools` is [{ name, description, parameters }]. */
export function buildRequest(provider, { model, apiKey, system, messages, tools = [] }) {
  const p = typeof provider === 'string' ? providerInfo(provider) : provider;
  const useModel = model || p.defaultModel;

  if (p.kind === 'openai') {
    const wire = [{ role: 'system', content: system }];
    for (const m of messages) {
      if (m.role === 'user') wire.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: m.text || null };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }));
        }
        wire.push(msg);
      } else if (m.role === 'tool') wire.push({ role: 'tool', tool_call_id: m.id, content: m.text });
    }
    const body = { model: useModel, messages: wire, temperature: 0.3 };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    return { url: p.url, headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body };
  }

  if (p.kind === 'anthropic') {
    const wire = [];
    for (const m of messages) {
      if (m.role === 'user') wire.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        wire.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.id, content: m.text };
        const last = wire.at(-1);
        // all the results of one round travel in a single user message
        if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
        else wire.push({ role: 'user', content: [block] });
      }
    }
    const body = { model: useModel, max_tokens: 1024, system, messages: wire };
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    return {
      url: p.url,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
    };
  }

  if (p.kind === 'gemini') {
    const contents = [];
    for (const m of messages) {
      if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.text }] });
      else if (m.role === 'assistant') {
        const parts = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
        contents.push({ role: 'model', parts });
      } else if (m.role === 'tool') {
        const part = { functionResponse: { name: m.name, response: { result: m.text } } };
        const last = contents.at(-1);
        if (last?.role === 'user' && last.parts.every((x) => x.functionResponse)) last.parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      }
    }
    const body = { systemInstruction: { parts: [{ text: system }] }, contents };
    if (tools.length) {
      body.tools = [
        { functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) },
      ];
    }
    return {
      url: p.url.replace('{model}', encodeURIComponent(useModel)),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    };
  }

  throw new Error(`fournisseur sans API : ${p.id}`);
}

let counter = 0;
const newId = () => `call_${Date.now().toString(36)}_${(counter += 1)}`;

/** Provider JSON -> { text, toolCalls: [{ id, name, args }] }. Throws on an error payload. */
export function parseResponse(provider, json) {
  const p = typeof provider === 'string' ? providerInfo(provider) : provider;
  if (json?.error) {
    const msg = typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error);
    throw new Error(msg);
  }

  if (p.kind === 'openai') {
    const msg = json?.choices?.[0]?.message;
    if (!msg) throw new Error('Réponse vide du fournisseur.');
    const toolCalls = (msg.tool_calls ?? []).map((c) => {
      let args = {};
      try {
        args = JSON.parse(c.function?.arguments || '{}');
      } catch {
        /* the model produced broken JSON: run the tool with no arguments */
      }
      return { id: c.id ?? newId(), name: c.function?.name, args };
    });
    return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls };
  }

  if (p.kind === 'anthropic') {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    if (!blocks.length) throw new Error('Réponse vide du fournisseur.');
    return { text, toolCalls };
  }

  if (p.kind === 'gemini') {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      const why = json?.promptFeedback?.blockReason ?? json?.candidates?.[0]?.finishReason;
      throw new Error(why ? `Réponse bloquée (${why}).` : 'Réponse vide du fournisseur.');
    }
    const text = parts.filter((x) => typeof x.text === 'string').map((x) => x.text).join('\n');
    const toolCalls = parts.filter((x) => x.functionCall).map((x) => ({ id: newId(), name: x.functionCall.name, args: x.functionCall.args ?? {} }));
    return { text, toolCalls };
  }

  throw new Error(`fournisseur sans API : ${p.id}`);
}

/** Plain-text tool protocol, for providers without native tool calling (Claude Code CLI). */
export function textProtocolPrompt(tools) {
  const list = tools.map((t) => `- ${t.name}(${Object.keys(t.parameters?.properties ?? {}).join(', ')}) : ${t.description}`).join('\n');
  return (
    'Outils disponibles :\n' +
    list +
    '\n\nPour utiliser UN outil, réponds UNIQUEMENT avec un bloc de code json de cette forme, sans autre texte :\n' +
    '```json\n{"tool": "nom_de_l_outil", "args": {}}\n```\n' +
    'Quand tu as fini (ou si aucun outil n’est nécessaire), réponds normalement en français, sans bloc json.'
  );
}

/** The tool call a model wrote as a fenced json block, or null. */
export function parseTextToolCall(text) {
  const m = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text ?? '');
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (typeof obj.tool !== 'string') return null;
    return { id: newId(), name: obj.tool, args: obj.args && typeof obj.args === 'object' ? obj.args : {} };
  } catch {
    return null;
  }
}
