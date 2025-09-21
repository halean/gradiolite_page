// Minimal, browser-only POC for a three-column Codex-like UI.
// - Chat powered by Pyodide (WASM) for local logic
// - Optional OpenAI provider (no backend; API key stays in browser)
// - Code extraction from chat replies (``` fenced blocks)
// - Code executed in an isolated Pyodide WebWorker ("GradioliteRunner")

const $ = (sel) => document.querySelector(sel);
const chatLog = $('#chat-log');
const chatInput = $('#chat-input');
const chatSend = $('#chat-send');
const codeHost = $('#code-editor-host');
const codeLang = $('#code-lang');
const runBtn = $('#run-code');
const nbRoot = $('#notebook');
const runtimeStatus = $('#runtime-status');
const llmProviderSel = $('#llm-provider');
const openaiKeyInput = $('#openai-key');
const saveLLMBtn = $('#save-llm');
const runtimeProviderSel = $('#runtime-provider');
const gradioRoot = $('#gradio-root');
const jliteRoot = $('#jlite-root');
const jliteIframe = $('#jupyterlite_cmd');
let htmlPreviewWindow = null;
// Examples UI elements
const examplesList = document.querySelector('#examples-list');
const examplesSearch = document.querySelector('#examples-search');
const examplesTabs = document.querySelectorAll('.examples-tabs button');
let examplesActiveTab = 'codes';
let examplesData = { codes: [], prompts: [] };
// Persistent settings
const storage = {
  get(key, def=null) { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } },
  set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
};

// Restore LLM provider settings
llmProviderSel.value = storage.get('llm_provider', 'toy');
openaiKeyInput.value = storage.get('openai_key', '');
runtimeProviderSel.value = storage.get('runtime_provider', 'pyodide');

saveLLMBtn.addEventListener('click', () => {
  storage.set('llm_provider', llmProviderSel.value);
  storage.set('openai_key', openaiKeyInput.value);
  storage.set('runtime_provider', runtimeProviderSel.value);
  appendChat('system', `Saved LLM provider: ${llmProviderSel.value}`);
});

// Monaco Editor setup (VS Code-like editor)
let monacoEditor = null;
let monacoNS = null;
let gradioLiteReadyPromise = null;
let appConfig = {
  runtime: { default: 'pyodide' },
  gradioLite: { augmentRequirements: true, defaultRequirements: ['transformers-js-py'] },
  cdn: {
    pyodideBase: 'https://cdn.jsdelivr.net/pyodide/v0.26.1/full/',
    gradioLite: 'https://cdn.jsdelivr.net/npm/@gradio/lite/dist/lite.js',
    monacoBase: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.48.0/min/vs'
  },
  tips: [],
  tipsByArea: { chat: [], code: [], examples: [], output: [] }
};

async function loadConfig() {
  try {
    const r = await fetch('assets/config.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const cfg = await r.json();
    appConfig = {
      ...appConfig,
      ...cfg,
      gradioLite: { ...appConfig.gradioLite, ...(cfg.gradioLite || {}) },
      cdn: { ...appConfig.cdn, ...(cfg.cdn || {}) }
    };
  } catch {}
  // Try to load examples from optional JSON
  try {
    const r2 = await fetch('assets/examples.json', { cache: 'no-cache' });
    if (r2.ok) {
      const ex = await r2.json();
      const norm = { codes: Array.isArray(ex.codes) ? ex.codes : [], prompts: Array.isArray(ex.prompts) ? ex.prompts : [] };
      if (norm.codes.length || norm.prompts.length) examplesData = norm;
    }
  } catch {}
  // Optional tips override (ignored by toasts if absent)
  try {
    const r3 = await fetch('assets/tips.json', { cache: 'no-cache' });
    if (r3.ok) {
      const t = await r3.json();
      if (Array.isArray(t)) appConfig.tips = t;
      else {
        if (Array.isArray(t?.tips)) appConfig.tips = t.tips;
        if (t?.tipsByArea || t?.tips_by_area) appConfig.tipsByArea = (t.tipsByArea || t.tips_by_area);
      }
    }
  } catch {}
}

async function ensureMonaco() {
  if (monacoNS && monacoEditor) return;
  await loadConfig();
  // Load AMD loader
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const base = appConfig.cdn.monacoBase.replace(/\/vs\/?$/, '/vs');
    s.src = base + '/loader.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  // Configure paths and load editor
  // eslint-disable-next-line no-undef
  require.config({ paths: { vs: appConfig.cdn.monacoBase } });
  await new Promise((resolve, reject) => {
    // eslint-disable-next-line no-undef
    require(['vs/editor/editor.main'], () => resolve(), reject);
  });
  // eslint-disable-next-line no-undef
  monacoNS = window.monaco;
  monacoEditor = monacoNS.editor.create(codeHost, {
    value: '',
    language: 'python',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on',
    fontSize: 13,
    fontLigatures: false,
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
  });
  // Layout on resize of window for safety (automaticLayout helps too)
  window.addEventListener('resize', () => monacoEditor && monacoEditor.layout());
}

function setEditorValue(text) {
  if (monacoEditor) monacoEditor.setValue(text ?? '');
}
function getEditorValue() {
  return monacoEditor ? monacoEditor.getValue() : '';
}
function setEditorLanguage(lang) {
  if (!monacoEditor || !monacoNS) return;
  const model = monacoEditor.getModel();
  const map = { py: 'python', python: 'python', js: 'javascript', ts: 'typescript', html: 'html', md: 'markdown', bash: 'shell' };
  const target = map[lang] || 'python';
  monacoNS.editor.setModelLanguage(model, target);
}

// Chat utils
function appendChat(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = content;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Code extraction from markdown fences
function extractCodeFromMarkdown(md) {
  if (!md) return { language: null, code: '' };
  const htmlBlock = md.match(/```html\s*\n([\s\S]*?)```/i);
  if (htmlBlock) {
    return { language: 'html', code: htmlBlock[1].trim() };
  }
  const fence = md.match(/```(\w+)?\s*\n([\s\S]*?)```/m);
  if (fence) {
    const language = (fence[1] || 'python').toLowerCase();
    const code = fence[2].trim();
    return { language, code };
  }
  const generic = md.match(/```\s*([\s\S]*?)```/m);
  if (generic) {
    return { language: null, code: generic[1].trim() };
  }
  return { language: null, code: md.trim() };
}

function isWebsitePrompt(text) {
  if (!text) return false;
  return /(make|build|create|design|generate)\s+(a\s+)?(website|web\s*site|web\s*page|landing\s*page|portfolio\s*site|homepage)/i.test(text)
    || /\bresponsive\s+website\b/i.test(text)
    || /\bhtml\s+page\b/i.test(text);
}

function buildHtmlDocument(snippet) {
  const trimmed = (snippet || '').trim();
  if (!trimmed) return '';
  if (/<html[\s>]/i.test(trimmed)) return trimmed;
  if (/<body[\s>]/i.test(trimmed)) {
    return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>Generated Page</title>\n</head>\n${trimmed}\n</html>`;
  }
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>Generated Page</title>\n  <style>body{margin:0;font-family:system-ui,sans-serif;}</style>\n</head>\n<body>\n${trimmed}\n</body>\n</html>`;
}

function looksLikeHtml(text) {
  if (!text) return false;
  const snippet = text.trim();
  if (!snippet) return false;
  return /^<!DOCTYPE html>/i.test(snippet)
    || /<html[\s>]/i.test(snippet)
    || /<head[\s>]/i.test(snippet)
    || /<body[\s>]/i.test(snippet)
    || (/<[a-z][^>]*>/i.test(snippet) && /<\/[^>]+>/i.test(snippet));
}

function showHtmlPopup(html) {
  const docHtml = buildHtmlDocument(html);
  if (!docHtml) {
    appendChat('system', 'No HTML content to preview.');
    return;
  }
  try {
    if (htmlPreviewWindow && !htmlPreviewWindow.closed) {
      htmlPreviewWindow.close();
    }
    htmlPreviewWindow = window.open('', 'gradiolite-html-preview', 'width=960,height=720');
    if (!htmlPreviewWindow) {
      appendChat('system', 'Popup blocked. Allow popups to preview the page.');
      return;
    }
    htmlPreviewWindow.document.open();
    htmlPreviewWindow.document.write(docHtml);
    htmlPreviewWindow.document.close();
    htmlPreviewWindow.focus();
  } catch (err) {
    appendChat('system', `Unable to open preview: ${err.message}`);
  }
}

// Pyodide for chat-side logic (simple, local rules or utilities)
// We keep this lightweight; it's not used to run user code. That happens in a separate worker.
let pyodideReady = false;
let pyodide;
(async function initChatPyodide() {
  try {
    // Load Pyodide from CDN. This runs in main thread, small footprint for chat logic.
    // Note: Execution of user code is isolated in a dedicated worker.
    importScriptsPolyfill('https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js');
  } catch (e) {
    console.warn('importScriptsPolyfill failed (likely not needed on main thread):', e);
  }
  try {
    // In the main thread we can use globalThis.loadPyodide if script tag existed. To avoid layout changes,
    // we dynamically create the script once and then call loadPyodide from window.
    await ensurePyodideScript();
    pyodide = await globalThis.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.1/full/' });
    await pyodide.runPythonAsync();
    pyodideReady = true;
  } catch (e) {
    console.error('Failed to init chat Pyodide:', e);
  }
})();

function importScriptsPolyfill() { /* noop in main thread */ }

async function ensurePyodideScript() {
  if (globalThis.loadPyodide) return;
  await loadConfig();
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const base = appConfig.cdn.pyodideBase.replace(/\/$/, '');
    s.src = `${base}/pyodide.js`;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// LLM provider abstraction
async function callLLM(messages) {
  const provider = llmProviderSel.value;
  if (provider === 'openai') {
    const key = openaiKeyInput.value.trim();
    if (!key) {
      appendChat('system', 'OpenAI key missing. Falling back to Toy.');
      return callToyLLM(messages);
    }
    return callOpenAI(messages, key);
  }
  return callToyLLM(messages);
}

async function callToyLLM(messages) {
  // Use Pyodide toy function to craft a deterministic response with Python code.
  const last = messages[messages.length - 1]?.content || '';
  if (!pyodideReady) return 'Toy LLM initializing, please retry...';
  const resp = await pyodide.runPythonAsync(`toy_llm_response(${JSON.stringify(last)})`);
  return resp;
}

async function callOpenAI(messages, key) {
  // Simple, model-agnostic call using Chat Completions. No backend.
  const body = {
    model: 'gpt-5-mini',
    messages,
    
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OpenAI error: ${r.status} ${txt}`);
  }
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || '';
  return content;
}

// GradioliteRunner: a dedicated WebWorker with its own Pyodide to run code safely
let runner;
let runnerReady = false;
function bootRunner() {
  runner = new Worker('assets/py-runner.js');
  runner.onmessage = (ev) => {
    const { type, data } = ev.data || {};
    switch (type) {
      case 'ready':
        runnerReady = true;
        runtimeStatus.textContent = 'pyodide: ready';
        break;
      case 'stdout':
        appendStdout(data);
        break;
      case 'stderr':
        appendStderr(data);
        break;
      case 'display':
        appendDisplay(data);
        break;
      case 'result':
        // Mark cell done
        if (nbActiveCell) {
          const status = nbActiveCell.hdr.querySelector('.status');
          if (status) status.textContent = `exit ${data.exitCode}`;
        }
        break;
      case 'status':
        runtimeStatus.textContent = data;
        break;
      default:
        break;
    }
  };
}
bootRunner();

let nbCellCounter = 0;
let nbActiveCell = null;

function startNotebookCell() {
  const id = ++nbCellCounter;
  const cell = document.createElement('div');
  cell.className = 'nb-cell';
  const hdr = document.createElement('div');
  hdr.className = 'nb-hdr';
  hdr.innerHTML = `<span>In [${id}]</span><span class="status"></span>`;
  const body = document.createElement('div');
  body.className = 'nb-body';
  cell.appendChild(hdr);
  cell.appendChild(body);
  nbRoot.appendChild(cell);
  nbRoot.scrollTop = nbRoot.scrollHeight;
  nbActiveCell = { id, el: cell, hdr, body };
}

function appendStdout(text) {
  if (!nbActiveCell) startNotebookCell();
  const pre = document.createElement('pre');
  pre.className = 'nb-text nb-stdout';
  pre.textContent = text;
  nbActiveCell.body.appendChild(pre);
}

function appendStderr(text) {
  if (!nbActiveCell) startNotebookCell();
  const pre = document.createElement('pre');
  pre.className = 'nb-text nb-stderr';
  pre.textContent = text;
  nbActiveCell.body.appendChild(pre);
}

function appendDisplay(payload) {
  if (!nbActiveCell) startNotebookCell();
  const kind = payload && payload.kind;
  if (kind === 'image' && payload.mime === 'image/png' && payload.data) {
    const img = document.createElement('img');
    img.className = 'nb-image';
    img.src = `data:${payload.mime};base64,${payload.data}`;
    nbActiveCell.body.appendChild(img);
  } else if (kind === 'html' && payload.html) {
    const div = document.createElement('div');
    div.innerHTML = payload.html;
    nbActiveCell.body.appendChild(div);
  } else if (payload && payload.text) {
    const pre = document.createElement('pre');
    pre.className = 'nb-text nb-stdout';
    pre.textContent = payload.text;
    nbActiveCell.body.appendChild(pre);
  }
}

// Wire chat interactions
const chatHistory = [
  {
    role: 'system',
    content:
      'You are a helpful coding assistant. Respond with code only: output a single runnable snippet in a ```<language>``` block. Choose the most appropriate language for the user\'s request. When the user asks for a website or webpage, return a complete HTML document (include inline CSS/JS if needed) in a ```html``` block. Do not include installation steps, pip/conda commands, environment setup, or extraneous prose. Assume all dependencies are available. Always have the objective in mind: provide code that can be run to achieve the user\'s goal. If you need to use a library, just use it. If you need to define a function or class, do so. Keep your responses concise and focused on the code needed to accomplish the task. If the user asks for an explanation, respond with brief comments in the code. Never say you are an AI model or mention limitations. Never include any text outside of the code block. End the code with the final value to return or print. If the user asks a non-coding question, respond with "I can only assist with coding tasks."',
  },
];

chatSend.addEventListener('click', async () => {
  const prompt = chatInput.value.trim();
  if (!prompt) return;
  chatInput.value = '';
  const wantsWebsite = isWebsitePrompt(prompt);
  appendChat('user', prompt);
  chatHistory.push({ role: 'user', content: prompt });

  appendChat('assistant', 'Thinking...');
  const thinkingEl = chatLog.lastElementChild;
  try {
    const reply = await callLLM(chatHistory);
    thinkingEl.textContent = reply;
    chatHistory.push({ role: 'assistant', content: reply });
    const { language, code } = extractCodeFromMarkdown(reply);
    const effectiveLang = language || (wantsWebsite ? 'html' : null);
    const effectiveCode = code || '';
    if (effectiveCode) {
      const normalizedLang = (effectiveLang || 'python').toLowerCase();
      codeLang.textContent = normalizedLang;
      setEditorLanguage(normalizedLang);
      setEditorValue(effectiveCode);
      if (normalizedLang === 'html' || wantsWebsite) {
        showHtmlPopup(effectiveCode);
      }
    } else if (wantsWebsite) {
      showHtmlPopup(reply);
    }
  } catch (e) {
    thinkingEl.textContent = `Error: ${e.message}`;
  }
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    chatSend.click();
    e.preventDefault();
  }
});

// Run code
runBtn.addEventListener('click', () => {
  const code = getEditorValue();
  if (!code.trim()) {
    appendOutput('No code to run.');
    return;
  }
  const currentLang = (codeLang.textContent || '').toLowerCase().trim();
  if (currentLang === 'html' || looksLikeHtml(code)) {
    showHtmlPopup(code);
    return;
  }
  const runtime = runtimeProviderSel.value;
  storage.set('runtime_provider', runtime);
  if (runtime === 'gradio-lite') {
    switchToView('gradio');
    // Execute code via embedded Gradio Lite runtime
    loadGradioLite(code);
  } else if (runtime === 'jupyterlite') {
    switchToView('jupyterlite');
    runtimeStatus.textContent = 'jupyterlite: loading';
    loadJupyterLite(code);
  } else {
    if (!runnerReady) {
      appendStderr('Runtime not ready yet.');
      return;
    }
    switchToView('console');
    startNotebookCell();
    runner.postMessage({ type: 'run', language: (codeLang.textContent || 'python').toLowerCase(), code });
  }
});

function switchToView(view) {
  const consoleView = nbRoot;
  const grRoot = gradioRoot;
  const jlRoot = jliteRoot;
  consoleView.classList.remove('active');
  grRoot.classList.remove('active');
  jlRoot.classList.remove('active');
  if (view === 'gradio') {
    grRoot.classList.add('active');
    runtimeStatus.textContent = 'gradio-lite: loading';
  } else if (view === 'jupyterlite') {
    jlRoot.classList.add('active');
    runtimeStatus.textContent = 'jupyterlite: loading';
  } else {
    consoleView.classList.add('active');
    runtimeStatus.textContent = 'pyodide: ready';
  }
}

// Encode Python code into data URL for lite host
function ensureGradioLiteLoaded() {
  if (customElements.get('gradio-lite')) return Promise.resolve();
  if (gradioLiteReadyPromise) return gradioLiteReadyPromise;
  gradioLiteReadyPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.type = 'module';
    s.src = appConfig.cdn.gradioLite;
    s.onload = () => customElements.whenDefined('gradio-lite').then(resolve, reject);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return gradioLiteReadyPromise;
}

function extractRequirementsFromCode(code) {
  // Support a simple header format:
  // # requirements:
  // # pkg-one
  // # pkg-two==1.2
  const lines = code.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^#\s*requirements:\s*$/i.test(lines[i])) { i++; break; }
  }
  if (i >= lines.length) return null;
  const pkgs = [];
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^#\s*(.+)$/);
    if (!m) break;
    const pkg = m[1].trim();
    if (pkg) pkgs.push(pkg);
  }
  return pkgs.length ? pkgs.join("\n") : null;
}

async function loadGradioLite(code) {
  await ensureGradioLiteLoaded();
  // If user provided a full <gradio-lite> snippet, augment it with requirements if missing
  if (code.includes('<gradio-lite')) {
    const container = document.createElement('div');
    container.innerHTML = code;
    const liteEl = container.querySelector('gradio-lite');
    if (!liteEl) {
      gradioRoot.innerHTML = code; // fallback: as-is injection
      runtimeStatus.textContent = 'gradio-lite: ready';
      return;
    }
    // Determine Python content
    let pyText = '';
    const scriptPy = liteEl.querySelector('script[type="py"]');
    if (scriptPy) {
      pyText = scriptPy.textContent || '';
    } else {
      // Concatenate text nodes excluding existing requirements
      liteEl.childNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() === 'gradio-requirements') return;
        if (n.nodeType === Node.TEXT_NODE) pyText += n.textContent || '';
      });
    }
    // Compute requirements: header + auto-detected + config defaults
    const reqHeader = extractRequirementsFromCode(pyText);
    const autoReqs = detectAutoRequirements(pyText);
    const reqSet = new Set([...(appConfig.gradioLite?.defaultRequirements || [])]);
    if (reqHeader) reqHeader.split(/\r?\n/).forEach((p) => p && reqSet.add(p.trim()));
    autoReqs.forEach((p) => reqSet.add(p));
    // Inject <gradio-requirements> if missing and we have any
    if (!liteEl.querySelector('gradio-requirements') && reqSet.size) {
      const reqEl = document.createElement('gradio-requirements');
      reqEl.textContent = Array.from(reqSet).join('\n');
      liteEl.appendChild(reqEl);
    }
    gradioRoot.replaceChildren(liteEl);
    runtimeStatus.textContent = 'gradio-lite: ready';
    return;
  }
  // Otherwise, wrap Python code in <gradio-lite> and add <gradio-requirements> if needed
  const lite = document.createElement('gradio-lite');
  lite.setAttribute("shared-worker","");
  lite.append(document.createTextNode(code));
  const reqHeader = extractRequirementsFromCode(code);
  const autoReqs = detectAutoRequirements(code);
  const reqSet = new Set([...(appConfig.gradioLite?.defaultRequirements || [])]);
  if (reqHeader) reqHeader.split(/\r?\n/).forEach((p) => p && reqSet.add(p.trim()));
  autoReqs.forEach((p) => reqSet.add(p));
  if (reqSet.size) {
    const reqEl = document.createElement('gradio-requirements');
    reqEl.textContent = Array.from(reqSet).join('\n');
    lite.appendChild(reqEl);
  }
  gradioRoot.replaceChildren(lite);
  runtimeStatus.textContent = 'gradio-lite: ready';
}

function detectAutoRequirements(pyText) {
  const reqs = new Set();
  // transformers_js_py usage
  if (/\bfrom\s+transformers_js_py\b/.test(pyText) || /\bimport\s+transformers_js_py\b/.test(pyText)) {
    reqs.add('transformers-js-py');
  }
  // Common alias import pattern: from transformers_js_py import pipeline
  if (/\bfrom\s+transformers_js_py\s+import\s+pipeline\b/.test(pyText)) {
    reqs.add('transformers-js-py');
  }
  return Array.from(reqs);
}

// Initialize default visible output view
switchToView(runtimeProviderSel.value === 'gradio-lite' ? 'gradio' : 'console');
// Initialize Monaco (ignore failures in offline/dev)
try { ensureMonaco().catch(() => {}); } catch (_) {}
// Preload Gradio Lite if currently selected; also load on selection change
if (runtimeProviderSel.value === 'gradio-lite') ensureGradioLiteLoaded();
runtimeProviderSel.addEventListener('change', () => {
  storage.set('runtime_provider', runtimeProviderSel.value);
  if (runtimeProviderSel.value === 'gradio-lite') {
    ensureGradioLiteLoaded();
    switchToView('gradio');
  } else if (runtimeProviderSel.value === 'jupyterlite') {
    switchToView('jupyterlite');
    runtimeStatus.textContent = 'jupyterlite: loading';
    loadJupyterLite(getEditorValue());
  } else {
    switchToView('console');
  }
});

function loadJupyterLite(code) {
  // Initialize local JupyterLite host page on first use
  if (jliteIframe && !jliteIframe.src) {
    jliteIframe.src = 'assets/_output/repl/index.html?toolbar=1&kernel=python';
  }
  // Send code to the iframe; it can decide how to seed it
  try {
    jliteIframe.contentWindow.postMessage({ type: 'seed-code', code }, '*');
  } catch {}
}

// -----------------------
// Examples: data + render
// -----------------------
const defaultExamples = {
  codes: [
    {
      id: 'hello-plot',
      title: 'Matplotlib: Sine Curve',
      desc: 'Simple plot rendered in the Pyodide console.',
      tags: ['python', 'matplotlib'],
      language: 'python',
      code: `import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(0, 2*np.pi, 200)\ny = np.sin(x)\nplt.plot(x, y)\nplt.title('Sine Curve')\nplt.show()`
    },
    {
      id: 'gradio-echo',
      title: 'Gradio: Echo App',
      desc: 'Minimal Gradio interface via Gradio Lite.',
      tags: ['python', 'gradio', 'ui'],
      language: 'python',
      code: `import gradio as gr\n\ndef echo(x):\n    return x\n\ndemo = gr.Interface(fn=echo, inputs=gr.Textbox(), outputs=gr.Textbox())\ndemo.launch()`
    },
    {
      id: 'pandas-summary',
      title: 'Pandas: DataFrame Summary',
      desc: 'Create a DataFrame and print describe().',
      tags: ['python', 'pandas'],
      language: 'python',
      code: `import pandas as pd\ndf = pd.DataFrame({\n    'a': [1,2,3,4,5],\n    'b': [10,20,30,20,10]\n})\nprint(df.describe())`
    }
  ],
  prompts: [
    { id: 'prompt-fib', title: 'Fibonacci function', text: 'Write a Python function that returns the first N Fibonacci numbers and print the list for N=20.' },
    { id: 'prompt-chart', title: 'Bar chart', text: 'Generate Python code to display a bar chart for fruit sales using matplotlib.' },
    { id: 'prompt-gradio', title: 'Gradio sentiment', text: 'Create a minimal Gradio app with a textbox and a label that returns whether the text is positive or negative (mock logic is fine).' },
    { id: 'prompt-gradio-transformer', title: 'Gradio sentiment with transformers', text: 'Create a minimal Gradio app with a textbox and a label that returns whether the text is positive or negative. Using transformer-js-py as pipeline. from transformers_js_py import pipeline. pipe = await pipeline ' },
    { id: 'prompt-html', title: 'Html single page application', text: 'Make me a snake game. It should be futuristic, neon, cyberpunk style. Make sure the typography is suitably cool.' }
  ]
};

function getExamples() {
  const data = {
    codes: (examplesData.codes && examplesData.codes.length ? examplesData.codes : defaultExamples.codes),
    prompts: (examplesData.prompts && examplesData.prompts.length ? examplesData.prompts : defaultExamples.prompts),
  };
  return data;
}

function renderExamples() {
  if (!examplesList) return;
  const query = (examplesSearch?.value || '').toLowerCase();
  const data = getExamples();
  const items = examplesActiveTab === 'codes' ? data.codes : data.prompts;
  const filtered = items.filter((it) => {
    const hay = [it.title, it.desc, it.text, (it.tags || []).join(' ')].join(' ').toLowerCase();
    return hay.includes(query);
  });

  examplesList.replaceChildren();
  filtered.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'example-item';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = it.title || 'Untitled';
    el.appendChild(title);
    if (it.desc) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = it.desc;
      el.appendChild(desc);
    }
    if (it.tags && it.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'tags';
      it.tags.forEach((t) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = t;
        tags.appendChild(span);
      });
      el.appendChild(tags);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (examplesActiveTab === 'codes') {
      const selectRuntime = (rt) => {
        if (!rt) return;
        runtimeProviderSel.value = rt;
        runtimeProviderSel.dispatchEvent(new Event('change'));
      };
      const guessRuntimeForCode = (item) => {
        if (item.runtime) return item.runtime;
        const blob = `${(item.code||'')} ${(item.tags||[]).join(' ')}`.toLowerCase();
        if (blob.includes('gradio') || blob.includes('<gradio-lite')) return 'gradio-lite';
        return 'jupyterlite';
      };
      const insertBtn = document.createElement('button');
      insertBtn.textContent = 'Insert';
      insertBtn.addEventListener('click', () => {
        if (it.language) setEditorLanguage(it.language);
        if (codeLang) codeLang.textContent = (it.language || 'python');
        setEditorValue(it.code || '');
        selectRuntime(guessRuntimeForCode(it));
      });
      const runBtn2 = document.createElement('button');
      runBtn2.textContent = 'Run';
      runBtn2.addEventListener('click', () => {
        if (it.language) setEditorLanguage(it.language);
        if (codeLang) codeLang.textContent = (it.language || 'python');
        setEditorValue(it.code || '');
        selectRuntime(guessRuntimeForCode(it));
        runBtn?.click();
      });
      actions.appendChild(insertBtn);
      actions.appendChild(runBtn2);
    } else {
      const sendBtn = document.createElement('button');
      sendBtn.textContent = 'Send';
      sendBtn.addEventListener('click', () => {
        if (chatInput) chatInput.value = it.text || '';
        // Default prompts to JupyterLite unless runtime specified
        const rt = it.runtime || 'jupyterlite';
        runtimeProviderSel.value = rt;
        runtimeProviderSel.dispatchEvent(new Event('change'));
        chatSend?.click();
      });
      const insertBtn = document.createElement('button');
      insertBtn.textContent = 'Insert';
      insertBtn.addEventListener('click', () => {
        if (chatInput) chatInput.value = it.text || '';
        const rt = it.runtime || 'jupyterlite';
        runtimeProviderSel.value = rt;
        runtimeProviderSel.dispatchEvent(new Event('change'));
        chatInput?.focus();
      });
      actions.appendChild(sendBtn);
      actions.appendChild(insertBtn);
    }
    el.appendChild(actions);
    examplesList.appendChild(el);
  });
}

examplesTabs?.forEach((btn) => {
  btn.addEventListener('click', () => {
    examplesTabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    examplesActiveTab = btn.dataset.tab;
    renderExamples();
  });
});
examplesSearch?.addEventListener('input', () => renderExamples());

// Initial render (after a tick so elements exist)
setTimeout(renderExamples, 0);

// -----------------------
// Tips ticker (footer)
// -----------------------
const defaultTipsList = [
  'Tip: Press Ctrl/Cmd+Enter to send chat',
  'Tip: Use # requirements: in code to auto-install for Gradio Lite',
  'Tip: Switch runtime from the dropdown: Pyodide, Gradio Lite, JupyterLite',
  'Tip: Insert an Example and hit Run',
  'Tip: Your API key stays in your browser',
  'Tip: Service worker caches assets for offline use'
];

const defaultTipsByArea = {
  chat: [
    'Chat: Ask for code, then use Insert',
    'Chat: Shift+Enter adds a newline',
  ],
  code: [
    'modify the code and press run to see the result',
    'Code: Change language under the Code header',
    'Code: Use # requirements: to add packages',
  ],
  examples: [
    'Examples: Click Run to auto-select runtime',
    'Examples: Prompts send directly to chat',
  ],
  output: [
    'Output: Switch views using the Runtime dropdown',
    'Output: Images and text appear as cells',
  ],
  runtime: [
    'click here to change run time',
    'jupyter lite is for displaying plots',
    'gradio is for interactive web ui',
    'pyodide is great for quick scripts',
  ],
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// (Removed legacy ticker/debug code)

// Toast tips: context-dependent, every 2 seconds while hovering
function initTipsToasts() {
  // Create container once
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Build per-area tips
  const byArea = {
    chat: [
      'Chat: Ask for code, then use Insert',
      'Chat: Shift+Enter adds a newline',
    ],
    code: [
      'Code: Modify the code and press Run',
      'Code: Change language under the header',
    ],
    examples: [
      'Examples: Click Run to auto-select runtime',
      'Examples: Prompts send directly to chat',
    ],
    output: [
      'Console: Results and plots appear here',
      'Console: Switch runtime from the dropdown',
    ],
    runtime: [
      'Runtime: Click to change where code runs',
      'Runtime: JupyterLite for plots, Gradio for UI',
    ],
  };
  Object.keys(byArea).forEach((k) => { if (!Array.isArray(byArea[k])) byArea[k] = []; });
  const idx = { chat: 0, code: 0, examples: 0, output: 0, runtime: 0 };

  function nextTipFor(area) {
    const arr = byArea[area] && byArea[area].length ? byArea[area] : [''];
    const i = (idx[area] || 0) % arr.length;
    idx[area] = (i + 1) % arr.length;
    return arr[i];
  }

  function showToast(text, duration = 1800) {
    if (!text) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    container.appendChild(t);
    // Animate in
    requestAnimationFrame(() => { t.classList.add('show'); });
    // Schedule hide
    setTimeout(() => {
      t.classList.add('hide');
      setTimeout(() => { t.remove(); }, 250);
    }, duration);
  }

  let activeArea = null;
  let timer = null;

  function startArea(area) {
    stopArea();
    activeArea = area;
    showToast(nextTipFor(activeArea));
    timer = setInterval(() => {
      showToast(nextTipFor(activeArea));
    }, 2000);
  }
  function stopArea() {
    if (timer) { clearInterval(timer); timer = null; }
    activeArea = null;
  }

  const areaMap = {
    chat: document.getElementById('chat-panel'),
    code: document.getElementById('code-panel'),
    examples: document.getElementById('examples-panel'),
    output: document.getElementById('output-panel'),
  };
  Object.entries(areaMap).forEach(([area, el]) => {
    if (!el) return;
    el.addEventListener('mouseenter', () => startArea(area));
    el.addEventListener('mouseleave', () => stopArea());
  });
  if (runtimeProviderSel) {
    runtimeProviderSel.addEventListener('mouseenter', () => startArea('runtime'));
    runtimeProviderSel.addEventListener('mouseleave', () => stopArea());
  }
}

// Bottom-bar tips (static text, context dependent)
function initBottomTips() {
  const track = document.getElementById('tips-track');
  if (!track) return;
  // Defaults + optional overrides
  const byArea = {
    chat: [
      'Chat: Ask for code, then use Insert',
      'Chat: Shift+Enter adds a newline',
      'Chat: Be specific about inputs and outputs',
      'Chat: Say which libraries you prefer',
      'Chat: Ask for a short runnable snippet',
      'Chat: Use Examples to get started faster',
    ],
    code: [
      'Code: Modify the code and press Run',
      'Code: Change language under the header',
      'Code: Pick runtime from the dropdown',
      'Code: Use # requirements: to add packages (Gradio Lite)',
      'Code: Use Examples → Codes to insert snippets',
      'Code: Keep plots in JupyterLite; UIs in Gradio',
    ],
    examples: [
      'Examples: Click Run to auto-select runtime',
      'Examples: Prompts send directly to chat',
      'Examples: Use search to filter examples',
      'Examples: Insert to load code into the editor',
      'Examples: Gradio items switch runtime automatically',
      'Examples: Prompt ideas help shape better code',
    ],
    output: [
      'Console: Results and plots appear here',
      'Console: Switch runtime from the dropdown',
      'Console: Each run adds a new cell',
      'Console: Errors show in red (stderr)',
      'Console: Use JupyterLite for plotting-heavy code',
      'Console: Use Gradio for interactive demos',
    ],
    runtime: [
      'Runtime: Click to change where code runs',
      'Runtime: JupyterLite for plots, Gradio for UI',
      'Runtime: Pyodide is fast for quick scripts',
      'Runtime: Switch anytime without losing code',
      'Runtime: Choose based on the output you need',
    ],
    
  };
  Object.keys(byArea).forEach((k) => { if (!Array.isArray(byArea[k])) byArea[k] = []; });
  const idx = { chat: 0, code: 0, examples: 0, output: 0, runtime: 0 };

  function nextTip(area) {
    const arr = byArea[area] && byArea[area].length ? byArea[area] : [''];
    const i = (idx[area] || 0) % arr.length;
    idx[area] = (i + 1) % arr.length;
    return arr[i];
  }

  let activeArea = 'output';
  let timer = null;

  function renderOnce() {
    track.textContent = nextTip(activeArea) || '';
  }
  function startCycle(area) {
    stopCycle();
    activeArea = area;
    renderOnce();
    timer = setInterval(renderOnce, 5000);
  }
  function stopCycle() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Hook areas
  const areaMap = {
    chat: document.getElementById('chat-panel'),
    code: document.getElementById('code-panel'),
    examples: document.getElementById('examples-panel'),
    output: document.getElementById('output-panel'),
  };
  Object.entries(areaMap).forEach(([area, el]) => {
    if (!el) return;
    el.addEventListener('mouseenter', () => startCycle(area));
    el.addEventListener('mouseleave', () => startCycle('output'));
  });
  if (runtimeProviderSel) {
    runtimeProviderSel.addEventListener('mouseenter', () => startCycle('runtime'));
    runtimeProviderSel.addEventListener('mouseleave', () => startCycle('output'));
  }

  // Start with default area
  startCycle('output');
}

window.addEventListener('load', initBottomTips);
