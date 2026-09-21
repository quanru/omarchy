import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { ComputerAgent, agentForComputer } from '@midscene/computer';
import { defineNode, z } from '@midscene/test';
import { defineProjectSetup, defineTestProject } from '@midscene/test/config';
import { createMidsceneNodes } from '@midscene/test/midscene';

interface FcitxContext {
  agent?: ComputerAgent;
  createAgent: () => Promise<ComputerAgent>;
  fixApplied: boolean;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const stop = async (child?: ChildProcess) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    try { process.kill(-child.pid!, 'SIGTERM'); }
    catch { clearTimeout(timer); done(); }
  });
};

// Run a command inside the disposable Omarchy VM over the harness's SSH port
// forward, inside the live Hyprland session. Mirrors the environment the
// official acceptance suite exports.
function guest(command: string): string {
  const key = process.env.OMARCHY_SSH_KEY;
  if (!key) throw new Error('OMARCHY_SSH_KEY is required for Omarchy tests');
  const env = [
    'export XDG_RUNTIME_DIR=/run/user/$(id -u);',
    'export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus;',
    'export HYPRLAND_INSTANCE_SIGNATURE=$(ls -t "$XDG_RUNTIME_DIR/hypr" | head -1);',
    'export WAYLAND_DISPLAY=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -name "wayland-*" ! -name "*.lock" -printf "%f\\n" | head -1);',
    'export OMARCHY_PATH=/usr/share/omarchy;',
    'export PATH="$OMARCHY_PATH/bin:$PATH";',
  ].join(' ');
  return execFileSync('ssh', [
    '-i', key, '-p', '2222', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10', '-o', 'LogLevel=ERROR',
    'omarchy@127.0.0.1', `${env} ${command}`,
  ], { encoding: 'utf8', timeout: 30_000 }).trim();
}

const waitForFcitx = () => guest(
  'for wait_step in $(seq 1 40); do fcitx5-remote >/dev/null 2>&1 && exit 0; sleep 0.5; done; '
  + 'echo "fcitx5 did not come back up" >&2; exit 1',
);

// Retried cases restart fcitx5 repeatedly within systemd's default start-rate
// window; clear the failed counter first so restart is not refused.
const restartFcitx = () => {
  guest('systemctl --user reset-failed omarchy-fcitx5.service 2>/dev/null || true; '
    + 'systemctl --user restart omarchy-fcitx5.service');
  waitForFcitx();
};

const clientClasses = () => guest(
  'hyprctl -j clients | jq -r \'[.[].class] | join(",")\'',
);

const fcitxPopupCount = () => Number.parseInt(
  guest('hyprctl -j clients | jq -r \'[.[] | select((.class // "") | ascii_downcase | test("fcitx|quickphrase"))] | length\''),
  10,
) || 0;

// Inject a chord through QEMU's QMP monitor on the HOST (the VM runs on the
// runner). QMP send-key arrives as real hardware keyboard input, so it passes
// through both Hyprland's global keybind handling and fcitx5's input-method
// filter — the path wtype's virtual keyboard does not reliably reach. qcode
// names follow the harness: Super is meta_l and the `/~ key is grave_accent.
const qmpPress = (qcodes: string[]) => {
  const sock = process.env.OMARCHY_QMP_SOCK;
  if (!sock) throw new Error('OMARCHY_QMP_SOCK is required for QMP key injection');
  const keys = qcodes.map((code) => JSON.stringify({ type: 'qcode', data: code })).join(',');
  const payload = `{"execute":"qmp_capabilities"}\n{"execute":"send-key","arguments":{"keys":[${keys}]}}\n`;
  execFileSync('socat', ['-t', '2', '-', `UNIX-CONNECT:${sock}`], {
    input: payload, encoding: 'utf8', timeout: 5000,
  });
};

const setup = defineProjectSetup<FcitxContext>({
  name: 'fcitx',
  async setup({ onTeardown }) {
    const createAgent = async () => agentForComputer({
      // The run script starts a readiness-checked Xvfb hosting Fluxbox and the
      // VNC viewer; don't let the ComputerAgent race its own Xvfb launch.
      headless: false,
      xvfbResolution: '1280x800x24',
      keepXvfbAliveUntilProcessExit: true,
      aiContexts: {
        aiAssert: 'Inspect the real Omarchy Hyprland desktop through VNC. Judge only visibly rendered pixels; never infer success from commands or configuration.',
      },
    });
    const context: FcitxContext = { createAgent, fixApplied: false };
    context.agent = await createAgent();
    onTeardown(() => context.agent?.destroy());

    const fluxbox = spawn('fluxbox', [], { detached: true, stdio: 'ignore', env: process.env });
    onTeardown(() => stop(fluxbox));
    await sleep(1000);

    const viewer = spawn('vncviewer', ['-FullScreen=1', '-RemoteResize=0', '-ViewOnly=0', '127.0.0.1:5905'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    onTeardown(() => stop(viewer));
    await sleep(4000);

    onTeardown(() => {
      try {
        guest('rm -f "$HOME/.config/fcitx5/conf/quickphrase.conf" "$HOME/.config/fcitx5/conf/quickphrase.conf".bak.*');
        restartFcitx();
      } catch (error) {
        console.error('Could not restore fcitx5 state:', error);
      }
    });

    return context;
  },
});

const empty = z.strictObject({});

const openTerminal = defineNode<typeof empty, void, FcitxContext>({
  name: 'shell.openTerminal',
  description: 'Launch (or focus) the default Omarchy terminal and wait until it is focused.',
  inputSchema: empty,
  async execute() {
    // omarchy-launch-terminal always maps a new window, so retried cases
    // accumulate terminals. Close previous ones first so every case starts
    // with a single, freshly focused terminal that receives the IM keys.
    guest('for terminal_name in foot alacritty ghostty kitty xterm; do pkill -x "$terminal_name" 2>/dev/null || true; done');
    await sleep(600);
    const terminalClass = '^(foot|alacritty|ghostty|kitty|xterm)$';
    const firstAddress = () => guest(
      `hyprctl -j clients | jq -r '[.[] | select(.class | ascii_downcase | test("${terminalClass}"))][0].address // empty'`,
    );
    guest('setsid omarchy-launch-terminal >/dev/null 2>&1 </dev/null &');
    let address = '';
    for (let attempt = 0; attempt < 15; attempt++) {
      address = firstAddress();
      if (address) break;
      await sleep(1000);
    }
    if (!address) {
      throw new Error('No terminal window appeared after omarchy-launch-terminal');
    }
    try {
      guest(`hyprctl dispatch focuswindow "address:${address}"`);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.toString().trim();
      console.warn(`[shell] focuswindow address:${address} failed${stderr ? `: ${stderr}` : ''}`);
    }
    await sleep(500);
  },
});

const resetDefault = defineNode<typeof empty, void, FcitxContext>({
  name: 'fcitx.resetDefault',
  description: 'Remove the shipped QuickPhrase user override and restart fcitx5, restoring stock Omarchy behavior.',
  inputSchema: empty,
  execute({ context }) {
    guest('rm -f "$HOME/.config/fcitx5/conf/quickphrase.conf" "$HOME/.config/fcitx5/conf/quickphrase.conf".bak.*');
    restartFcitx();
    context.fixApplied = false;
  },
});

const applyFix = defineNode<typeof empty, void, FcitxContext>({
  name: 'fcitx.applyFix',
  description: 'Run the shipped migration against an existing QuickPhrase config that still inherits the upstream triggers.',
  inputSchema: empty,
  execute({ context }) {
    // This config contains another user choice but only commented TriggerKey
    // defaults. A whole-file guard used to skip this upgrade case.
    guest('mkdir -p "$HOME/.config/fcitx5/conf"; '
      + 'printf \'%s\\n\' \'# Trigger Key\' \'# [TriggerKey]\' \'# 0=Super+grave\' '
      + '\'# 1=Super+semicolon\' \'Choose Modifier=Alt\' '
      + '>"$HOME/.config/fcitx5/conf/quickphrase.conf"; '
      + 'bash -euo pipefail "$OMARCHY_PATH/migrations/1789983273.sh"');
    const deployed = guest('cat "$HOME/.config/fcitx5/conf/quickphrase.conf"');
    const expected = [
      '# Trigger Key',
      '# [TriggerKey]',
      '# 0=Super+grave',
      '# 1=Super+semicolon',
      'Choose Modifier=Alt',
      '',
      '[TriggerKey]',
      '0=Super+semicolon',
    ].join('\n');
    if (deployed !== expected) {
      throw new Error(`Migrated quickphrase.conf did not preserve user config and install the narrowed trigger list:\n${deployed}`);
    }
    waitForFcitx();
    context.fixApplied = true;
  },
});

// fcitx5's compiled-in default QuickPhrase triggers are Super+grave and
// Super+semicolon. QuickPhrase swallows the first typed character into its
// own preedit strip, which is what makes the control/treatment difference
// visible. Keys go through QMP on the host (a real keyboard), not the
// virtual-keyboard path.
const invokeInput = z.strictObject({
  // QMP qcodes of the trigger chord; defaults to Super+grave.
  chord: z.array(z.string()).optional(),
});

const invokeQuickPhrase = defineNode<typeof invokeInput, void, FcitxContext>({
  name: 'fcitx.invokeQuickPhrase',
  description: 'Press a QuickPhrase trigger chord followed by the letter a via QMP hardware-keyboard injection.',
  inputSchema: invokeInput,
  async execute({ input, context }) {
    const chord = input.chord && input.chord.length > 0 ? input.chord : ['meta_l', 'grave_accent'];
    const before = fcitxPopupCount();
    qmpPress(chord);
    await sleep(700);
    qmpPress(['a']);
    await sleep(1000);
    const after = fcitxPopupCount();
    console.log(
      `[fcitx] fixApplied=${context.fixApplied} chord=${chord.join('+')} popup clients ${before} -> ${after}; `
      + `classes after: ${clientClasses()}`,
    );
  },
});

const cancel = defineNode<typeof empty, void, FcitxContext>({
  name: 'fcitx.cancel',
  description: 'Dismiss QuickPhrase if open and clear the terminal input line (QMP keys).',
  inputSchema: empty,
  async execute() {
    qmpPress(['escape']);
    await sleep(200);
    qmpPress(['ctrl', 'c']);
    await sleep(200);
  },
});

export default defineTestProject<FcitxContext>({
  test: { maxConcurrency: 1, testTimeout: 8 * 60_000 },
  projects: [
    {
      name: 'omarchy-fcitx5',
      retry: 2,
      setup,
      files: { include: ['cases/fcitx5-quickphrase.yaml'] },
    },
  ],
  nodes: [
    ...createMidsceneNodes<FcitxContext>({
      agentClass: ComputerAgent,
      agentProvider: (() => {
        const active = new Map<string, { agent: ComputerAgent; context: FcitxContext }>();
        return {
          async getAgent(runId: string, execution) {
            const { context } = execution;
            const existing = active.get(runId);
            if (existing) return existing.agent;
            context.agent ??= await context.createAgent();
            active.set(runId, { agent: context.agent, context });
            return context.agent;
          },
          async releaseAgent(runId: string) {
            const entry = active.get(runId);
            if (!entry) throw new Error(`No Agent for Midscene case ${runId}`);
            active.delete(runId);
            const { agent, context } = entry;
            await agent.destroy();
            context.agent = undefined;
            if (!agent.reportFile) throw new Error(`No Agent report for Midscene case ${runId}`);
            return { reportPath: agent.reportFile };
          },
        };
      })(),
    }),
    openTerminal,
    resetDefault,
    applyFix,
    invokeQuickPhrase,
    cancel,
  ],
});
