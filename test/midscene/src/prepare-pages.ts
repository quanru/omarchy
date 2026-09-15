import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type RunSummary = {
  generatedAt: string;
  requestedRuns: number;
  passedRuns: number;
  failedRuns: number;
  stabilityRate: number;
  runs: Array<{ durationMs: number; calls: number; totalTokens: number }>;
};

type ReportEntry = {
  runId: string;
  createdAt: string;
  commitSha: string;
  workflowUrl: string;
  reportPath: string;
  requestedRuns: number;
  passedRuns: number;
  failedRuns: number;
  stabilityRate: number;
  averageDurationSeconds: number;
  calls: number;
  tokens: number;
};

type ReportManifest = {
  version: 1;
  generatedAt: string;
  retention: number;
  reports: ReportEntry[];
};

const [artifactArgument, outputArgument] = process.argv.slice(2);
if (!artifactArgument || !outputArgument) {
  throw new Error('Usage: prepare-pages <artifact-directory> <output-directory>');
}

const artifactDir = resolve(artifactArgument);
const outputDir = resolve(outputArgument);
const baseUrl = requiredEnvironment('PAGES_BASE_URL').replace(/\/$/u, '');
const runId = requiredEnvironment('GITHUB_RUN_ID');
const repository = requiredEnvironment('GITHUB_REPOSITORY');
const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const retention = positiveInteger(process.env.MIDSCENE_REPORT_RETENTION ?? '10');

if (!/^\d+$/u.test(runId)) throw new Error('GITHUB_RUN_ID must contain only digits');

const summary = JSON.parse(
  await readFile(join(artifactDir, 'summary.json'), 'utf8'),
) as RunSummary;
const reportDirectory = join(artifactDir, 'midscene_run', 'report');
const reportName = (await readdir(reportDirectory)).find((name) => name.endsWith('.html'));
if (!reportName) throw new Error('Midscene did not generate an HTML report');

const previousManifest = await fetchManifest(`${baseUrl}/reports/manifest.json`);
const previousReports = previousManifest.reports
  .filter((entry) => entry.runId !== runId)
  .filter(validHistoricalEntry)
  .slice(0, Math.max(0, retention - 1));

await mkdir(join(outputDir, 'reports', runId), { recursive: true });
await writeFile(
  join(outputDir, 'reports', runId, 'index.html'),
  await readFile(join(reportDirectory, reportName)),
);

for (const entry of previousReports) {
  const destination = join(outputDir, entry.reportPath);
  await mkdir(join(outputDir, 'reports', entry.runId), { recursive: true });
  await download(`${baseUrl}/${entry.reportPath}`, destination);
}

const durationMs = summary.runs.reduce((total, run) => total + run.durationMs, 0);
const currentReport: ReportEntry = {
  runId,
  createdAt: summary.generatedAt,
  commitSha: process.env.GITHUB_SHA ?? '',
  workflowUrl: `${serverUrl}/${repository}/actions/runs/${runId}`,
  reportPath: `reports/${runId}/index.html`,
  requestedRuns: summary.requestedRuns,
  passedRuns: summary.passedRuns,
  failedRuns: summary.failedRuns,
  stabilityRate: summary.stabilityRate,
  averageDurationSeconds: summary.runs.length === 0 ? 0 : durationMs / summary.runs.length / 1000,
  calls: summary.runs.reduce((total, run) => total + run.calls, 0),
  tokens: summary.runs.reduce((total, run) => total + run.totalTokens, 0),
};
const manifest: ReportManifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  retention,
  reports: [currentReport, ...previousReports],
};

await mkdir(join(outputDir, 'reports'), { recursive: true });
await writeFile(join(outputDir, 'reports', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(outputDir, 'index.html'), renderIndex(manifest));
await writeFile(join(outputDir, '.nojekyll'), '');
console.log(`Prepared ${manifest.reports.length} browser report(s); current path: ${currentReport.reportPath}`);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('MIDSCENE_REPORT_RETENTION must be an integer from 1 to 50');
  }
  return value;
}

function validHistoricalEntry(entry: ReportEntry): boolean {
  return /^\d+$/u.test(entry.runId) && entry.reportPath === `reports/${entry.runId}/index.html`;
}

async function fetchManifest(url: string): Promise<ReportManifest> {
  const response = await fetch(`${url}?cache=${Date.now()}`, {
    headers: { accept: 'application/json' },
  });
  if (response.status === 404) {
    return { version: 1, generatedAt: new Date(0).toISOString(), retention, reports: [] };
  }
  if (!response.ok) throw new Error(`Could not restore report history: HTTP ${response.status}`);
  const manifest = (await response.json()) as Partial<ReportManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.reports)) {
    throw new Error('The published report manifest is invalid');
  }
  return manifest as ReportManifest;
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(`${url}?cache=${Date.now()}`);
  if (!response.ok) throw new Error(`Could not restore ${url}: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderIndex(manifest: ReportManifest): string {
  const rows = manifest.reports
    .map((entry) => {
      const stability = `${entry.passedRuns}/${entry.requestedRuns} (${(entry.stabilityRate * 100).toFixed(1)}%)`;
      return `        <tr>
          <td><a href="${escapeHtml(entry.reportPath)}">${escapeHtml(entry.runId)}</a></td>
          <td>${escapeHtml(new Date(entry.createdAt).toLocaleString('en-GB', { timeZone: 'UTC' }))} UTC</td>
          <td>${escapeHtml(stability)}</td>
          <td>${escapeHtml(entry.averageDurationSeconds.toFixed(2))}s</td>
          <td>${escapeHtml(entry.calls)}</td>
          <td>${escapeHtml(entry.tokens)}</td>
          <td><a href="${escapeHtml(entry.workflowUrl)}">CI run</a></td>
        </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Omarchy Midscene report history</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0 auto; max-width: 1100px; padding: 48px 24px; }
      h1 { margin-bottom: 8px; }
      p { color: #777; margin-top: 0; }
      table { border-collapse: collapse; margin-top: 32px; width: 100%; }
      th, td { border-bottom: 1px solid #8885; padding: 12px; text-align: left; }
      th { font-size: 0.82rem; text-transform: uppercase; }
      a { color: #4f7cff; }
    </style>
  </head>
  <body>
    <h1>Omarchy Midscene report history</h1>
    <p>Latest ${escapeHtml(manifest.retention)} successful reports, newest first.</p>
    <table>
      <thead><tr><th>Run</th><th>Generated</th><th>Stability</th><th>Avg duration</th><th>Calls</th><th>Tokens</th><th>Workflow</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </body>
</html>
`;
}
