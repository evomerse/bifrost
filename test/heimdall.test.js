import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_LINKS, PROVIDERS, buildRequest, parseResponse, parseTextToolCall, providerInfo } from '../desktop/heimdall/providers.js';
import { createTools } from '../desktop/heimdall/tools.js';
import { createHeimdall } from '../desktop/heimdall/assistant.js';
import { createSecretStore } from '../desktop/heimdall/secrets.js';

const tools = [
  { name: 'empty_trash', description: 'Vide la corbeille', parameters: { type: 'object', properties: {} } },
  { name: 'run_command', description: 'cmd', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];
const convo = [
  { role: 'user', text: 'vide la corbeille' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'empty_trash', args: {} }] },
  { role: 'tool', id: 'c1', name: 'empty_trash', text: 'Corbeille vidée.' },
];

test('OpenAI-compatible request (Groq, ChatGPT, Grok)', () => {
  for (const id of ['groq', 'openai', 'xai']) {
    const r = buildRequest(id, { apiKey: 'K', system: 'sys', messages: convo, tools });
    assert.equal(r.headers.authorization, 'Bearer K');
    assert.equal(r.body.model, PROVIDERS[id].defaultModel);
    assert.equal(r.body.messages[0].role, 'system');
    assert.equal(r.body.messages[2].tool_calls[0].function.name, 'empty_trash');
    assert.equal(r.body.messages[3].role, 'tool');
    assert.equal(r.body.messages[3].tool_call_id, 'c1');
    assert.equal(r.body.tools[0].type, 'function');
  }
  assert.match(buildRequest('groq', { apiKey: 'K', system: 's', messages: [] }).url, /api\.groq\.com/);
});

test('Anthropic request merges tool results into one user message', () => {
  const r = buildRequest('anthropic', {
    apiKey: 'K',
    system: 'sys',
    messages: [...convo, { role: 'tool', id: 'c2', name: 'run_command', text: 'x' }],
    tools,
  });
  assert.equal(r.headers['x-api-key'], 'K');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.body.system, 'sys');
  const last = r.body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content.map((b) => b.tool_use_id), ['c1', 'c2']);
  assert.equal(r.body.tools[1].input_schema.required[0], 'command');
});

test('Gemini request: key in a header, model in the path, empty schemas dropped', () => {
  const r = buildRequest('gemini', { apiKey: 'K', model: 'gemini-x', system: 'sys', messages: convo, tools });
  assert.match(r.url, /models\/gemini-x:generateContent$/);
  assert.equal(r.headers['x-goog-api-key'], 'K');
  assert.equal(r.url.includes('K'), false, 'the key never goes in the URL');
  assert.equal(r.body.contents[1].role, 'model');
  assert.equal(r.body.contents[2].parts[0].functionResponse.name, 'empty_trash');
  assert.equal(r.body.tools[0].functionDeclarations[0].parameters, undefined);
  assert.ok(r.body.tools[0].functionDeclarations[1].parameters);
});

test('responses are parsed for every kind', () => {
  const openai = parseResponse('groq', {
    choices: [{ message: { content: null, tool_calls: [{ id: 'a', function: { name: 'empty_trash', arguments: '{}' } }] } }],
  });
  assert.deepEqual(openai.toolCalls[0], { id: 'a', name: 'empty_trash', args: {} });
  assert.equal(parseResponse('groq', { choices: [{ message: { content: 'salut' } }] }).text, 'salut');

  const anthropic = parseResponse('anthropic', {
    content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name: 'run_command', input: { command: 'dir' } }],
  });
  assert.equal(anthropic.text, 'ok');
  assert.equal(anthropic.toolCalls[0].args.command, 'dir');

  const gemini = parseResponse('gemini', {
    candidates: [{ content: { parts: [{ text: 'a' }, { functionCall: { name: 'empty_trash', args: {} } }] } }],
  });
  assert.equal(gemini.toolCalls[0].name, 'empty_trash');
  assert.ok(gemini.toolCalls[0].id);

  assert.throws(() => parseResponse('groq', { error: { message: 'bad key' } }), /bad key/);
  assert.throws(() => parseResponse('gemini', { promptFeedback: { blockReason: 'SAFETY' } }), /SAFETY/);
  const broken = parseResponse('groq', { choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'n', arguments: '{oops' } }] } }] });
  assert.deepEqual(broken.toolCalls[0].args, {});
});

test('Claude Code text protocol', () => {
  assert.equal(parseTextToolCall('```json\n{"tool":"empty_trash","args":{}}\n```').name, 'empty_trash');
  assert.equal(parseTextToolCall('Bonjour !'), null);
  assert.equal(parseTextToolCall('```json\n{"nope":1}\n```'), null);
  assert.equal(parseTextToolCall('```json\n{broken\n```'), null);
});

test('only known providers and links', () => {
  assert.equal(providerInfo('???').id, 'groq');
  assert.ok(EXTERNAL_LINKS.has('https://console.groq.com/keys'));
  assert.equal(EXTERNAL_LINKS.has('https://evil.example/'), false);
});

test('tools: read-only ones run without confirmation, changing ones ask', async () => {
  const calls = [];
  const t = createTools({
    platform: 'win32',
    run: async (file, args) => {
      calls.push([file, args]);
      return { code: 0, stdout: 'ok', stderr: '' };
    },
  });
  for (const name of ['system_info', 'disk_usage', 'top_processes', 'check_updates']) assert.equal(t.get(name).confirm, undefined, name);
  for (const name of ['empty_trash', 'clean_temp_files', 'run_command']) assert.equal(typeof t.get(name).confirm, 'function', name);
  assert.match(t.get('run_command').confirm({ command: 'del *.*' }), /del \*\.\*/);

  assert.equal(await t.get('empty_trash').run({}), 'ok');
  assert.equal(calls[0][0], 'powershell.exe');
  const script = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  assert.match(script, /Clear-RecycleBin/);

  await t.get('check_updates').run({});
  assert.match(Buffer.from(calls[1][1].at(-1), 'base64').toString('utf16le'), /Microsoft\.Update\.Session/);
  assert.equal(t.definitions().every((d) => d.run === undefined), true, 'executors never reach the model');
});

test('tools: unix flavours', async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    return { code: 0, stdout: 'x', stderr: '' };
  };
  await createTools({ platform: 'darwin', run }).get('empty_trash').run({});
  assert.equal(calls[0][0], 'osascript');
  await createTools({ platform: 'linux', run }).get('empty_trash').run({});
  assert.deepEqual(calls[1], ['gio', ['trash', '--empty']]);
  const r = await createTools({ platform: 'linux', run: async () => ({ code: 3, stdout: '', stderr: 'boom' }) }).get('disk_usage').run({});
  assert.match(r, /Échec \(code 3\)/);
});

function fakeApi(responses) {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = responses.shift();
    return { ok: r.status === undefined, status: r.status ?? 200, statusText: 'x', json: async () => r.json };
  };
  return { fetchFn, sent };
}

test('assistant: model asks for a tool, person confirms, result goes back to the model', async () => {
  const { fetchFn, sent } = fakeApi([
    { json: { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'empty_trash', arguments: '{}' } }] } }] } },
    { json: { choices: [{ message: { content: 'La corbeille est vide.' } }] } },
  ]);
  const asked = [];
  const ran = [];
  const h = createHeimdall({
    getConfig: () => ({ provider: 'groq', model: '', apiKey: 'gsk_test' }),
    confirm: async (text) => {
      asked.push(text);
      return true;
    },
    fetchFn,
    tools: createTools({
      platform: 'win32',
      run: async (...a) => {
        ran.push(a);
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    }),
  });
  const r = await h.ask('vide la corbeille');
  assert.equal(r.reply, 'La corbeille est vide.');
  assert.equal(r.steps[0].status, 'done');
  assert.equal(asked.length, 1);
  assert.equal(ran.length, 1);
  assert.equal(sent[0].headers.authorization, 'Bearer gsk_test');
  assert.equal(sent[1].body.messages.at(-1).role, 'tool');
});

test('assistant: a refused action is not executed', async () => {
  const { fetchFn } = fakeApi([
    { json: { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'run_command', arguments: '{"command":"format c:"}' } }] } }] } },
    { json: { choices: [{ message: { content: 'D’accord, je ne fais rien.' } }] } },
  ]);
  const ran = [];
  const h = createHeimdall({
    getConfig: () => ({ provider: 'openai', model: 'gpt', apiKey: 'k' }),
    confirm: async () => false,
    fetchFn,
    tools: createTools({
      platform: 'win32',
      run: async (...a) => {
        ran.push(a);
        return { code: 0, stdout: '', stderr: '' };
      },
    }),
  });
  const r = await h.ask('formate le disque');
  assert.equal(ran.length, 0);
  assert.equal(r.steps[0].status, 'denied');
});

test('assistant: unknown tools are reported to the model, bad keys explained', async () => {
  const unknown = fakeApi([
    { json: { choices: [{ message: { tool_calls: [{ id: 'z', function: { name: 'rm_rf', arguments: '{}' } }] } }] } },
    { json: { choices: [{ message: { content: 'Je ne peux pas.' } }] } },
  ]);
  const h = createHeimdall({ getConfig: () => ({ provider: 'groq', apiKey: 'k' }), confirm: async () => true, fetchFn: unknown.fetchFn });
  const r = await h.ask('x');
  assert.equal(r.steps[0].status, 'error');
  assert.match(r.steps[0].output, /inconnu/);

  const denied = fakeApi([{ status: 401, json: { error: { message: 'Invalid API Key' } } }]);
  const h2 = createHeimdall({ getConfig: () => ({ provider: 'groq', apiKey: 'bad' }), confirm: async () => true, fetchFn: denied.fetchFn });
  await assert.rejects(h2.ask('x'), /Clé API refusée/);

  const none = createHeimdall({
    getConfig: () => ({ provider: 'groq', apiKey: '' }),
    confirm: async () => true,
    fetchFn: async () => assert.fail('no request without a key'),
  });
  await assert.rejects(none.ask('x'), /Aucune clé API/);
});

test('assistant: Claude Code provider uses the text protocol', async () => {
  const replies = ['```json\n{"tool":"system_info","args":{}}\n```', 'Votre PC va bien.'];
  const prompts = [];
  const h = createHeimdall({
    getConfig: () => ({ provider: 'claude-code', model: '', apiKey: '' }),
    confirm: async () => true,
    claudeCode: async (prompt) => {
      prompts.push(prompt);
      return replies.shift();
    },
    tools: createTools({ platform: 'linux', run: async () => ({ code: 0, stdout: '', stderr: '' }) }),
  });
  const r = await h.ask('comment va mon pc ?');
  assert.equal(r.reply, 'Votre PC va bien.');
  assert.equal(r.steps[0].name, 'system_info');
  assert.match(prompts[0], /system_info/);
  assert.match(prompts[1], /Résultat de l’outil system_info/);
});

test('secret store: encrypted when the OS offers it, readable round trip, never plain in that case', () => {
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`ENC(${s})`),
    decryptString: (b) => b.toString().slice(4, -1),
  };
  const store = createSecretStore(fake);
  const sealed = store.seal('gsk_secret');
  assert.ok(sealed.startsWith('enc:'));
  assert.equal(sealed.includes('gsk_secret'), false);
  assert.equal(store.open(sealed), 'gsk_secret');
  assert.equal(store.open('garbage'), '');
  assert.equal(store.seal(''), '');

  const bare = createSecretStore({ isEncryptionAvailable: () => false });
  assert.equal(bare.encrypted, false);
  assert.equal(bare.open(bare.seal('abc')), 'abc');
  assert.equal(bare.open(sealed), '', 'a key sealed by an OS store cannot be opened without it');
});
