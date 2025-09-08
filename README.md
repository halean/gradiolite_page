# Gradiolite – Browser POC

Self‑contained, static web app for a Codex‑style chat + code + runtime playground. No backend required; execution runs in the browser via Pyodide, Gradio Lite, or JupyterLite.

## Features
- Chat UI with optional OpenAI provider (key stays client‑side)
- Monaco editor for code
- Runtimes: Pyodide worker, Gradio Lite, JupyterLite REPL
- Service worker for caching with path‑aware, network‑first strategy

## Project Structure
- `index.html`: App shell and layout
- `assets/app.js`: UI logic, editor, runtimes wiring
- `assets/style.css`: Styles
- `assets/py-runner.js`: Pyodide worker for executing code
- `assets/_output/repl/index.html`: JupyterLite REPL (self‑hosted)
- `assets/sw.js`: Service Worker (network‑first under `assets/`)
- `.nojekyll`: Ensures `_output` is served on GitHub Pages

## Local Preview
You can serve the folder with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Publish to GitHub Pages
1) Initialize git and push to a new GitHub repo (see below).
2) In GitHub: Settings → Pages → Source: “Deploy from a branch”, Branch: your default (e.g., `main`), Folder: `/ (root)`.
3) Visit: `https://<USER>.github.io/<REPO>/` after the deploy finishes.

Notes
- Service worker: on each deploy, bump `VERSION` in `assets/sw.js:1` if you need to force cache refreshes.
- Paths are relative, so project Pages under `/REPO/` work. `.nojekyll` makes sure `_output` content is served.

## Create a New Repo (quick start)
```bash
git init
# (optional) git branch -M main
# (optional) git add . && git commit -m "init: gradiolite browser poc"
# (optional) git remote add origin git@github.com:<USER>/<REPO>.git
# (optional) git push -u origin main
```

---
MIT or your preferred license.
