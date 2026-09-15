# Proposal: an optional semantic UI verification layer for Omarchy

Omarchy already has a strong graphical acceptance foundation. The
`omarchy-iso` harness installs and boots a real VM, QMP sends compositor-level
shortcuts, Bash verifies system state, OCR verifies visible text, and each run
captures screenshots. This proposal keeps all of that intact.

The small gap I would like to explore is semantic: after the deterministic
checks pass, does the rendered desktop actually look and behave like the right
experience to a user?

As Omarchy makes intelligent workflows feel increasingly native to the desktop,
it may be worth letting a small, optional part of its validation understand
rendered intent as well—not instead of pixels, text, and process state, but on
top of them.

## Evidence from a real Omarchy plugin

I first used [Midscene](https://midscenejs.com/) for the UI E2E tests of
[Doubao Say](https://github.com/quanru/doubao-say), an open-source voice input
plugin for Linux, Wayland, and Omarchy. Those tests exercise the rendered
onboarding experience rather than mocking it.

- [Open the Doubao Say Midscene report](https://quanru.github.io/doubao-say/reports/34966813655/index.html)
- [Inspect the corresponding CI run](https://github.com/quanru/doubao-say/actions/runs/34966813655)

That experience suggested a similarly narrow experiment for Omarchy itself.

## Omarchy-native PoC

The isolated PoC boots a real installed Omarchy VM and validates one stable
contract:

1. QMP sends the real `Super + Space` shortcut.
2. Midscene verifies that the native Omarchy launcher is visibly correct.
3. QMP types `settings`; current `quattro` resolves the retained alias to
   `Setup`.
4. Midscene verifies the relevant result.
5. QMP presses Enter.
6. Midscene verifies the Setup page and its representative configuration
   choices.

QMP performs every interaction. Midscene is used only for semantic visual
assertions, so the AI layer cannot silently replace the deterministic input
path.

- [Open the Omarchy Midscene report](https://quanru.github.io/omarchy/reports/34963648995/)
- [Inspect the corresponding green CI run](https://github.com/quanru/omarchy/actions/runs/34963648995)
- [Review the isolated PoC branch](https://github.com/quanru/omarchy/tree/poc/midscene-semantic-ui)

An earlier ten-run measurement completed all 10 scenarios successfully:

- Stability: **10/10 (100%)**
- Average scenario duration: **29.22 seconds**
- Semantic assertions: **30**
- Usage: **56,410 input + 2,994 output tokens**
- Model connection retries: **6**, all recovered automatically

The latest linked run is a smaller green smoke run. It confirms the final CI
and browser-report publishing path without spending another full ten-run model
budget.

## Deliberate constraints

- Completely optional and isolated under `test/midscene`.
- Manual `workflow_dispatch` only.
- Not included in `test/all` and not proposed as a required check.
- No changes to existing Bash, OCR, screenshot, QMP, or VM assertions.
- Missing model credentials produce a successful skip before booting a VM.
- Pinned dependencies and one narrow scenario.
- Self-contained HTML replay, screenshots, duration, token usage, and optional
  cost calculation.
- Reports use traceable GitHub Run ID URLs, with the original evidence retained
  on each Actions run.

## Why this seems complementary

Exact checks remain the best tool for exact contracts. A semantic assertion is
useful when the user-visible contract combines several facts—for example, the
launcher can exist and contain OCR-readable text while still being clipped,
obscured, or showing the wrong kind of page.

This PoC adds that final user-facing question while leaving the existing test
architecture in control.

## Questions for maintainers

1. Does this optional, additive positioning fit how you want the acceptance
   suite to evolve?
2. Is launcher → Setup a useful first semantic contract, or would another
   existing acceptance path be more valuable?
3. If the stability, latency, and usage are acceptable, would you be open to a
   minimal PR that remains manual and non-required?

I am intentionally proposing discussion and evidence first—not a required
dependency or check.
