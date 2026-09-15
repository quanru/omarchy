# Midscene semantic UI PoC

This is an optional host-side experiment layered on top of Omarchy's existing VM acceptance infrastructure. QMP sends every real shortcut and key press; Midscene only judges the rendered UI. It does not replace `test/acceptance`, Bash assertions, OCR, or the `omarchy-iso` harness.

The single scenario is deliberately small and follows current Omarchy terminology:

1. Boot an installed Omarchy image as a disposable QEMU overlay.
2. Send `Super + Space` through QMP to open the real Omarchy menu.
3. Verify the launcher semantically with Midscene.
4. Type the historical search term `settings` through QMP and verify the matching `Setup` result.
5. Press Enter through QMP and verify the Setup/Settings page.
6. Repeat ten times and emit stability, duration, token, cost, screenshot, and HTML-report artifacts.

## Why this is isolated

`test/midscene` is a self-contained Node.js subproject with pinned dependencies. It is not called by `test/all` or `test/acceptance`, and it makes no change to the installed system. Removing this directory removes the PoC.

## Prerequisites

- An x86-64 Linux host with KVM, QEMU, OVMF, `socat`, SSH, Xvfb, Fluxbox, TigerVNC Viewer, and Node.js 22.
- A sibling checkout of [`omacom/omarchy-iso`](https://github.com/omacom/omarchy-iso), or `OMARCHY_ISO_REPO` pointing to it.
- An official Omarchy ISO. The first invocation lets the official harness install a reusable base image; later invocations reuse it and boot only a throwaway overlay.
- An OpenAI-compatible multimodal model supported by Midscene.

Install the isolated Node dependencies:

```bash
npm --prefix test/midscene ci --include=optional
```

Configure the model and run:

```bash
export MIDSCENE_MODEL_API_KEY=...
export MIDSCENE_MODEL_NAME=...
export MIDSCENE_MODEL_FAMILY=...
export MIDSCENE_MODEL_BASE_URL=...

test/midscene/run-poc.sh ../omarchy-iso/release/omarchy.iso
```

For local runs, `run-poc.sh` automatically loads an ignored `test/midscene/.env` file when it exists. GitHub Actions continues to read the same variables from repository secrets and does not use this local file.

For compatibility with the shared LifeOS environment, the runner maps the
`qwen3.7` model family to Midscene's `qwen3` coordinate protocol. The model name
itself is unchanged.

When `MIDSCENE_MODEL_API_KEY` is absent, the command reports an optional skip and exits successfully before booting a VM.

Set `OMARCHY_MIDSCENE_RUNS` to change the repetition count. It defaults to 10. Set both `MIDSCENE_INPUT_COST_PER_MILLION` and `MIDSCENE_OUTPUT_COST_PER_MILLION` to the selected model's USD prices if a dollar estimate is required. Token usage is always recorded when the provider returns it; cost remains `null` rather than guessing when prices are not supplied.

## Artifacts

Generated files are ignored by Git and written under `test/midscene/artifacts/`:

- `midscene_run/report/omarchy-midscene-poc.html` — self-contained Midscene report.
- `screenshots/` — three named PNGs per attempt, plus failure screenshots.
- `summary.json` — machine-readable stability, timing, usage, and cost data.
- `summary.md` — concise table suitable for a GitHub Discussion.
- `vm/` — disposable VM overlay and serial log.

Successful GitHub Actions runs also deploy the HTML file to GitHub Pages. Each
report has a traceable `reports/<github-run-id>/` URL, and the site root lists
the retained history with timestamps, stability, usage, and CI links. The
`Publish clickable HTML report` job summary links directly to the current run.
The deployment restores previous files before publishing and retains the latest
10 successful reports by default; per-run evidence also remains attached to its
workflow run as an artifact.

The VM overlay is always discarded on the next run. The reusable base remains under the sibling `omarchy-iso/test-runs/` directory.
