import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  agentForComputer,
  type ComputerAgent,
} from '@midscene/computer';

type Metrics = ComputerAgent['metrics'];

type RunResult = {
  run: number;
  passed: boolean;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  estimatedCostUsd: number | null;
  error?: string;
};

const qmpSocket = process.env.OMARCHY_QMP_SOCKET;
const artifactDir = resolve(process.env.OMARCHY_MIDSCENE_ARTIFACT_DIR ?? 'artifacts');
const runCount = Number.parseInt(process.env.OMARCHY_MIDSCENE_RUNS ?? '10', 10);
const inputPrice = optionalNumber('MIDSCENE_INPUT_COST_PER_MILLION');
const outputPrice = optionalNumber('MIDSCENE_OUTPUT_COST_PER_MILLION');

// Qwen 3.7 uses the same coordinate protocol as the qwen3 Midscene recipe.
// Keep this aligned with the LifeOS harness that owns the shared local .env.
if (process.env.MIDSCENE_MODEL_FAMILY === 'qwen3.7') {
  process.env.MIDSCENE_MODEL_FAMILY = 'qwen3';
}

if (!qmpSocket) throw new Error('OMARCHY_QMP_SOCKET is required');
if (!Number.isInteger(runCount) || runCount < 1 || runCount > 100) {
  throw new Error('OMARCHY_MIDSCENE_RUNS must be an integer from 1 to 100');
}

function optionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function qmp(execute: string, args?: Record<string, unknown>): void {
  const messages = [
    { execute: 'qmp_capabilities' },
    args ? { execute, arguments: args } : { execute },
  ];
  const result = execFileSync('socat', ['-t', '3', '-', `UNIX-CONNECT:${qmpSocket}`], {
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.includes('"error"')) throw new Error(`QMP ${execute} failed: ${result}`);
}

function press(...keys: string[]): void {
  qmp('send-key', {
    keys: keys.map((key) => ({ type: 'qcode', data: key })),
  });
}

async function settle(milliseconds = 900): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function capture(agent: ComputerAgent, run: number, step: string): Promise<void> {
  const screenshotBase64 = await agent.interface.screenshotBase64();
  const name = `run-${String(run).padStart(2, '0')}-${step}.png`;
  const encodedPng = screenshotBase64.slice(screenshotBase64.indexOf(',') + 1);
  await writeFile(join(artifactDir, 'screenshots', name), encodedPng, 'base64');
  await agent.recordToReport(`Run ${run}: ${step}`, { screenshotBase64 });
}

function metricsDelta(before: Metrics, after: Metrics) {
  return {
    promptTokens: after.totalPromptTokens - before.totalPromptTokens,
    completionTokens: after.totalCompletionTokens - before.totalCompletionTokens,
    totalTokens: after.totalTokens - before.totalTokens,
    calls: after.calls - before.calls,
  };
}

function estimateCost(promptTokens: number, completionTokens: number): number | null {
  if (inputPrice === null || outputPrice === null) return null;
  return (promptTokens * inputPrice + completionTokens * outputPrice) / 1_000_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopProcessGroup(child?: ChildProcess): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // The viewer may already have exited after a failed assertion.
  }
}

function markdownSummary(results: RunResult[], reportFile: string | null): string {
  const passed = results.filter((result) => result.passed).length;
  const durationMs = results.reduce((total, result) => total + result.durationMs, 0);
  const promptTokens = results.reduce((total, result) => total + result.promptTokens, 0);
  const completionTokens = results.reduce((total, result) => total + result.completionTokens, 0);
  const calls = results.reduce((total, result) => total + result.calls, 0);
  const knownCosts = results.map((result) => result.estimatedCostUsd).filter((cost): cost is number => cost !== null);
  const totalCost = knownCosts.length === results.length ? knownCosts.reduce((total, cost) => total + cost, 0) : null;
  const lines = [
    '# Omarchy Midscene semantic UI PoC',
    '',
    `- Stability: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`,
    `- Average duration: ${(durationMs / results.length / 1000).toFixed(2)}s`,
    `- Model calls: ${calls}`,
    `- Tokens: ${promptTokens} input / ${completionTokens} output`,
    `- Estimated model cost: ${totalCost === null ? 'not calculated (set both pricing variables)' : `$${totalCost.toFixed(6)}`}`,
    `- Midscene HTML report: ${reportFile ?? 'not generated'}`,
    '',
    '| Run | Result | Duration | Calls | Tokens | Estimated cost |',
    '| ---: | :---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of results) {
    lines.push(`| ${result.run} | ${result.passed ? 'pass' : 'fail'} | ${(result.durationMs / 1000).toFixed(2)}s | ${result.calls} | ${result.totalTokens} | ${result.estimatedCostUsd === null ? 'n/a' : `$${result.estimatedCostUsd.toFixed(6)}`} |`);
  }
  return `${lines.join('\n')}\n`;
}

await mkdir(join(artifactDir, 'screenshots'), { recursive: true });

let agent: ComputerAgent | undefined;
let fluxbox: ChildProcess | undefined;
let viewer: ChildProcess | undefined;
const results: RunResult[] = [];

try {
  agent = await agentForComputer({
    aiContexts: {
      aiAssert:
        'You are validating the native Omarchy desktop shown through a VNC viewer. ' +
        'Judge only what is visibly rendered. The root surface is called the Omarchy menu; ' +
        'the historical user term Settings maps to the current Setup submenu.',
    },
    generateReport: true,
    reportFileName: 'omarchy-midscene-poc',
    groupName: 'Omarchy native semantic UI PoC',
    groupDescription: 'QMP drives real shortcuts; Midscene adds semantic visual assertions.',
    xvfbResolution: '1280x800x24',
  });

  fluxbox = spawn('fluxbox', [], { detached: true, stdio: 'ignore', env: process.env });
  await settle(1_000);
  viewer = spawn(
    'vncviewer',
    ['-FullScreen=1', '-RemoteResize=0', '-ViewOnly=1', '127.0.0.1:5905'],
    { detached: true, stdio: 'ignore', env: process.env },
  );
  await settle(4_000);

  for (let run = 1; run <= runCount; run += 1) {
    const startedAt = Date.now();
    const before = agent.metrics;
    let passed = false;
    let failure: string | undefined;

    try {
      press('esc');
      await settle(500);
      press('meta_l', 'spc');
      await settle();
      await capture(agent, run, 'launcher');
      await agent.aiAssert(
        'The Omarchy launcher is visibly open and shows its main navigation choices, including Apps and Setup.',
        `Run ${run}: launcher is visible`,
      );

      for (const character of 'settings') {
        press(character);
        await settle(80);
      }
      await settle();
      await capture(agent, run, 'search-results');
      await agent.aiAssert(
        'The launcher visibly shows a relevant Setup or Settings search result for the typed query "settings".',
        `Run ${run}: Settings search result is visible`,
      );

      press('ret');
      await settle();
      await capture(agent, run, 'settings-page');
      await agent.aiAssert(
        'The visible menu is the Setup/Settings page and shows multiple configuration choices such as Monitors, Keybindings, Input, Network, or Defaults.',
        `Run ${run}: Setup/Settings page is visible`,
      );
      passed = true;
    } catch (error) {
      failure = errorMessage(error);
      try {
        await capture(agent, run, 'failure');
        await agent.recordErrorToReport(`Run ${run} failed`, { error });
      } catch {
        // Preserve the original assertion or transport error.
      }
    } finally {
      press('esc');
      await settle(400);
    }

    const delta = metricsDelta(before, agent.metrics);
    results.push({
      run,
      passed,
      durationMs: Date.now() - startedAt,
      ...delta,
      estimatedCostUsd: estimateCost(delta.promptTokens, delta.completionTokens),
      ...(failure ? { error: failure } : {}),
    });
    console.log(`run ${run}/${runCount}: ${passed ? 'passed' : `failed: ${failure}`}`);
  }
} finally {
  stopProcessGroup(viewer);
  stopProcessGroup(fluxbox);
  if (agent) await agent.destroy();
}

const reportFile = agent?.reportFile ?? null;
const passed = results.filter((result) => result.passed).length;
const summary = {
  generatedAt: new Date().toISOString(),
  model: process.env.MIDSCENE_MODEL_NAME ?? null,
  requestedRuns: runCount,
  passedRuns: passed,
  failedRuns: results.length - passed,
  stabilityRate: results.length === 0 ? 0 : passed / results.length,
  pricingUsdPerMillionTokens: {
    input: inputPrice,
    output: outputPrice,
  },
  reportFile,
  runs: results,
};

await writeFile(join(artifactDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(join(artifactDir, 'summary.md'), markdownSummary(results, reportFile));
console.log(markdownSummary(results, reportFile));

// Some optional desktop/X11 child processes may leave a non-zero exitCode even
// after they have been shut down cleanly. The scenario results are the source
// of truth for the workflow conclusion.
process.exitCode = passed === runCount ? 0 : 1;
