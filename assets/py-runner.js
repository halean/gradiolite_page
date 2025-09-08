// WebWorker: isolated Python runtime using Pyodide to execute code.
// Receives { type: 'run', language, code }
// Sends back messages: 'ready', 'stdout', 'stderr', 'display', 'result', 'status'

self.postStatus = (msg) => postMessage({ type: 'status', data: msg });

// Load Pyodide in worker
let pyodide;
const DEFAULT_CONFIG = {
  cdn: { pyodideBase: 'https://cdn.jsdelivr.net/pyodide/v0.26.1/full/' }
};
const PRELOAD_PKGS = ['numpy', 'matplotlib', 'scikit-learn', 'scipy'];
(async function exposeDisplayEmitter(){
  // Expose a JS function for Python to call: from js import _gr_emit
  self._gr_emit = (payload) => {
    try { postMessage({ type: 'display', data: payload }); } catch {}
  };
})();

async function loadWorkerConfig() {
  try {
    const r = await fetch('assets/config.json', { cache: 'no-cache' });
    if (!r.ok) return DEFAULT_CONFIG;
    const cfg = await r.json();
    return { ...DEFAULT_CONFIG, ...cfg, cdn: { ...DEFAULT_CONFIG.cdn, ...(cfg.cdn || {}) } };
  } catch {
    return DEFAULT_CONFIG;
  }
}
(function exposeDisplayEmitter(){
  // Expose a JS function for Python to call: from js import _gr_emit
  self._gr_emit = (payload) => {
    try { postMessage({ type: 'display', data: payload }); } catch {}
  };
})();
(async function init() {
  try {
    const cfg = await loadWorkerConfig();
    const base = (cfg.cdn.pyodideBase || DEFAULT_CONFIG.cdn.pyodideBase).replace(/\/$/, '');
    importScripts(`${base}/pyodide.js`);
    self.postStatus('pyodide: downloading');
    pyodide = await loadPyodide({ indexURL: `${base}/` });
    self.postStatus('pyodide: loading packages');
    try {
      await pyodide.loadPackage(PRELOAD_PKGS);
      self.postStatus('pyodide: packages ready');
    } catch (e) {
      postMessage({ type: 'stderr', data: 'Package load error: ' + (e && e.message ? e.message : String(e)) + '\n' });
    }
    self.postStatus('pyodide: loaded');
    postMessage({ type: 'ready' });
  } catch (e) {
    postMessage({ type: 'stderr', data: 'Failed to initialize Pyodide: ' + e.message + '\n' });
  }
})();

async function runPython(code) {
  // Redirect stdout/stderr
  const py = pyodide.pyimport;
  await pyodide.runPythonAsync(`
import sys, io
import builtins
_gr_stdout = io.StringIO()
_gr_stderr = io.StringIO()
_gr_old_out, _gr_old_err = sys.stdout, sys.stderr
sys.stdout, sys.stderr = _gr_stdout, _gr_stderr

# Install a displayhook to send the repr of the last expression
try:
    from js import _gr_emit as _gr_emit
    def _gr_displayhook(value):
        if value is None:
            return
        try:
            _gr_emit({'kind': 'text', 'text': repr(value)})
        except Exception:
            pass
    _gr_old_displayhook = sys.displayhook
    sys.displayhook = _gr_displayhook
except Exception:
    _gr_old_displayhook = None

# If matplotlib is present, patch plt.show() to emit PNG and also emit at cell end
try:
    import matplotlib
    matplotlib.use('Agg', force=True)
    import matplotlib.pyplot as plt
    import base64, io
    from matplotlib._pylab_helpers import Gcf
    def _gr_emit_all_figures():
        managers = Gcf.get_all_fig_managers()
        for m in list(managers):
            fig = m.canvas.figure
            buf = io.BytesIO()
            try:
                fig.savefig(buf, format='png', bbox_inches='tight')
                data = base64.b64encode(buf.getvalue()).decode('ascii')
                _gr_emit({'kind': 'image', 'mime': 'image/png', 'data': data})
            finally:
                buf.close()
    def _gr_mpl_show(*args, **kwargs):
        try:
            _gr_emit_all_figures()
        finally:
            try:
                plt.close('all')
            except Exception:
                pass
    try:
        plt.show = _gr_mpl_show
    except Exception:
        pass
except Exception:
    pass
`);
  let exitCode = 0;
  try {
    await pyodide.runPythonAsync(code);
  } catch (e) {
    exitCode = 1;
    // Also push the JS exception message to stderr for visibility
    postMessage({ type: 'stderr', data: (e && e.message ? e.message : String(e)) + '\n' });
  } finally {
    const out = await pyodide.runPythonAsync(`_gr_stdout.getvalue()`);
    const err = await pyodide.runPythonAsync(`_gr_stderr.getvalue()`);
    // At cell end, if there are any pending figures, emit them
    try {
      await pyodide.runPythonAsync(`
try:
    _gr_emit_all_figures()
except Exception:
    pass
`);
    } catch (e) {}
    if (out) postMessage({ type: 'stdout', data: out });
    if (err) postMessage({ type: 'stderr', data: err });
    await pyodide.runPythonAsync(`
sys.stdout, sys.stderr = _gr_old_out, _gr_old_err
try:
    if _gr_old_displayhook is not None:
        import sys as _sys
        _sys.displayhook = _gr_old_displayhook
except Exception:
    pass
`);
  }
  postMessage({ type: 'result', data: { exitCode } });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'run') {
    const lang = (msg.language || 'python').toLowerCase();
    if (lang !== 'python' && lang !== 'py') {
      postMessage({ type: 'stderr', data: `Unsupported language: ${lang}\n` });
      postMessage({ type: 'result', data: { exitCode: 2 } });
      return;
    }
    postStatus('pyodide: running');
    await runPython(msg.code);
    postStatus('pyodide: ready');
  }
};

