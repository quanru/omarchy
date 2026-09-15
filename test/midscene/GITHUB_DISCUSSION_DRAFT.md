# PoC: an optional semantic UI verification layer for Omarchy acceptance tests

Omarchy already has a strong graphical acceptance system: the `omarchy-iso` harness installs and boots a real VM, QMP sends compositor-level shortcuts, Bash checks system state, OCR checks visible text, and the run captures screenshots. This proposal does not replace any of that.

I built a small, isolated proof of concept that adds Midscene only as a semantic visual assertion layer on top of the existing VM and QMP approach.

## What the PoC does

The scenario intentionally covers one stable path:

1. Boot a real installed Omarchy VM from a disposable overlay.
2. Send `Super + Space` with QMP.
3. Ask Midscene whether the native Omarchy launcher is visibly correct.
4. Type `settings` with QMP. On current `quattro`, this intentionally resolves through the retained alias to the `Setup` item.
5. Ask Midscene whether the relevant search result is visible.
6. Press Enter with QMP and ask Midscene whether the Setup/Settings page and representative configuration choices are visible.
7. Repeat the scenario ten times.

QMP performs all interaction. Midscene does not decide where to click or replace the deterministic input path.

## Results

The runner produces a self-contained HTML replay, screenshots for every state, and `summary.json`/`summary.md` files containing stability, per-run duration, model calls, tokens, and estimated cost.

<!-- Replace this block with test/midscene/artifacts/summary.md after a public run. -->

- Stability: pending first public run
- Average duration: pending first public run
- Model calls and tokens: pending first public run
- Estimated cost: pending first public run
- HTML report: pending artifact link

## Deliberate constraints

- Completely optional and isolated under `test/midscene`.
- Not part of `test/all` or the existing acceptance runner.
- No change to existing Bash, OCR, screenshot, QMP, or VM assertions.
- Manual `workflow_dispatch` only.
- Automatically skips successfully when no model API key is configured.
- Not proposed as a required check.
- Pinned Node dependencies and a single scenario to keep review and removal simple.
- Dollar cost is calculated only when explicit model prices are configured; the PoC never guesses pricing.

## Why this may be useful

The current checks are excellent at exact state and text assertions. A semantic layer can complement them when the user-visible contract spans several visual facts at once: for example, a launcher may technically exist and contain OCR-readable words while still being clipped, visually obscured, or presenting the wrong kind of page. The HTML replay also makes this class of failure easier to review after the VM is gone.

## Questions for maintainers

1. Is this narrow, optional positioning compatible with how you want the acceptance suite to evolve?
2. Is launcher → Setup the right first semantic contract, or is another existing acceptance path more useful?
3. If the stability and cost data are acceptable, would you be open to a later minimal PR that keeps this manual and non-required?

I would prefer to collect feedback and publish the ten-run evidence before proposing any production dependency or CI requirement.
