# Live Deck

Live Deck combines reveal.js slides, persistent Jupyter terminals, command
runbooks, monitoring panels and an optional AI advisor in one presentation.

The interface and full authoring documentation are currently in Chinese.

[中文文档](README.md) · [Authoring reference](web/docs/AUTHORING.md) · [Studio](web/docs/STUDIO.md) · [Product API](web/docs/PRODUCT-API.md) · [MIT License](LICENSE)

## Features

- Move between slides without losing terminal processes, shell variables or output.
- Use multiple terminal panels and named tabs, with reconnect, restart and reset controls.
- Keep an ordered runbook across terminals and dashboards. Inserting a command does
  not press Enter; the presenter controls execution and completion marks.
- Bind dashboard URL parameters and time ranges to metadata published by a running process.
- Ask an optional Codex-backed advisor about recent terminal output and the current plan.
  Suggestions are adopted into the command editor for review.
- Edit the document inside a true player canvas in Live Deck Studio, including
  in-place title, kicker and Markdown text editing, with undo/redo,
  reference-aware panel operations, diagnostics and an explicit apply-to-player step.
- Inspect the effective browser state and preview, apply, validate or undo supported
  document mutations through `window.liveDeck.productApi`.
- Render live ECharts time series from read-only, server-side Grafana queries without
  changing shared dashboards.
- Import, edit and export a single JSON deck. Frontend libraries are vendored;
  there is no frontend build step or runtime CDN dependency.

## Quick start

Use Python 3.11+, Bash and nbclassic on Jupyter Server 1.x. The requirements
include Notebook 6 for classic frontend compatibility. Launch with
`python -m nbclassic`: the old `python -m notebook` server ignores requested
terminal names and working directories and is not supported.
Notebook 7 and JupyterLab's native terminal pages are not supported by this adapter.

```bash
git clone https://github.com/KuribohG/LiveDeck.git
cd LiveDeck
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python install_local.py --server-url http://127.0.0.1:8888
python -m nbclassic --no-browser --port=8888
```

First sign in through the token-bearing URL printed by Jupyter. Then open
`http://127.0.0.1:8888/custom/live-deck/index.html`.
For an existing compatible Jupyter service, run the installer and refresh the
page. Supply the externally visible Jupyter URL, including any path prefix,
through `--server-url`; `--custom-dir` selects a different custom-file directory.

For a development machine, add `--link` to create a single-source install whose
player code links back to this clone. Git pulls then update the served player,
Studio, chart renderer and docs immediately. Installed deck JSON, rendered
examples and `deployment.json` remain local files; rerun the installer after
changing bundled decks. `scripts/link-site.py` links additional presentations to
the same checkout and pins their backend paths to that source tree.

The installer copies static files, renders local example paths and creates demo
workspaces under `~/.local/share/live-deck/workspaces` (`--workspace-dir` overrides
this). Re-running updates a managed installation and refuses to replace an
unmanaged directory or symlink. Keep the source checkout for the Python backend.

The bundled default decks use installer-only `{{LIVE_DECK_ROOT}}`,
`{{LIVE_DECK_WORKSPACES}}` and `{{LIVE_DECK_URL}}` placeholders. Export an installed
deck to obtain a standalone document. The minimal and tabs examples need no
substitution. Replace the multi-panel example's `grafana.example.com` URL with
your own dashboard; the monitoring example includes a local URL-parameter preview.

## Optional AI

Install and authenticate Codex CLI on the Jupyter server. The adapter requires
`codex app-server` and uses your existing model configuration. Override the model
with `python install_local.py --model MODEL_ID ...` or `LIVE_DECK_MODEL` in the
Jupyter process environment. Python kernel `python3` must be available.

AI credentials stay on the server. Asking a question sends the provided context,
including recent terminal output, to your configured model service. Inspect it
using the context preview before sending. The advisor requests a read-only
session and can discover the user's Codex Skills through a bounded read-only file
tool. If Grafana MCP is configured, only dashboard and datasource read tools are
enabled. Shell tools, memory, multi-agent execution, repository instructions and
other MCP servers are disabled. The advisor does not execute suggested commands
in the presentation. Slides, terminals and dashboards work without AI configuration.

## Development

Node.js 20+ is needed for validation and browser tests, not for serving slides.

```bash
npm ci
npm test
npm run test:studio
python -m unittest discover -s tests -p 'test_*.py'
node scripts/validate-deck.mjs web/examples/minimal.livedeck.json
python scripts/verify-vendor.py
```

Browser tests target a running compatible Jupyter server. Set
`LIVE_DECK_SERVER_INFO` to its runtime JSON, `LIVE_DECK_BROWSER_EXECUTABLE` to a
Chromium executable and `LIVE_DECK_TEST_ARTIFACTS` to an output directory. For
example, `node tests/browser-monitoring-example.mjs` checks real shells and the
rendered monitoring example without calling a model. AI browser tests make real
requests to the configured model service.

Commands run with the Jupyter user's permissions. Keep Jupyter authentication
enabled and use trusted decks. Terminal sessions share the host filesystem;
they are independent shells, not isolated containers. Dashboard embedding
depends on that site's authentication, cookies and frame policy.

## License

MIT. Bundled libraries retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
