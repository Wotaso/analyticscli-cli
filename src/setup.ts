import { createInterface } from 'node:readline/promises';
import {
  CLAWHUB_SITE_URL,
  ANALYTICSCLI_AUTO_REFRESH_SKILL_NAMES,
  ANALYTICSCLI_OPENCLAW_AUTO_REFRESH_SKILL_NAMES,
  ANALYTICSCLI_OPENCLAW_SETUP_SKILL_NAMES,
  ANALYTICSCLI_SETUP_SKILL_NAMES,
  CLI_VERSION,
  CLI_VERSION_CHECK_INTERVAL_MS,
  CLI_VERSION_CHECK_TIMEOUT_MS,
  SKILL_SYNC_INTERVAL_MS,
  SKILL_SYNC_TIMEOUT_MS,
  SKILLS_PUBLIC_REPO_SLUG,
} from './constants.js';
import { configPath, persistAuthToken, readConfig, resolveAuthToken, writeConfigValue } from './config-store.js';
import { isCommandAvailable, runCommand } from './shell.js';
import type {
  OutputFormat,
  PromptClient,
  SetupAgent,
  SetupExecutionOptions,
  SetupExecutionResult,
  SetupLoginResult,
  SkillInstallResult,
} from './types.js';

const formatCommand = (command: string, args: string[]) => `\`${[command, ...args].join(' ')}\``;

const normalizeConfiguredAgents = (agents: SetupAgent[]): SetupAgent[] => {
  const ordered: SetupAgent[] = ['codex', 'claude', 'openclaw'];
  return ordered.filter((agent) => agents.includes(agent));
};

export const resolveAutoRefreshSkillNames = (agents?: readonly SetupAgent[]): string[] => {
  const skillNames = new Set<string>(ANALYTICSCLI_AUTO_REFRESH_SKILL_NAMES);
  if (agents?.includes('openclaw')) {
    for (const skillName of ANALYTICSCLI_OPENCLAW_AUTO_REFRESH_SKILL_NAMES) {
      skillNames.add(skillName);
    }
  }

  return [...skillNames];
};

const getClawHubInvoker = (): { command: string; prefix: string[] } | null => {
  if (isCommandAvailable('clawhub')) {
    return { command: 'clawhub', prefix: [] };
  }

  if (isCommandAvailable('npx')) {
    return { command: 'npx', prefix: ['-y', 'clawhub'] };
  }

  return null;
};

const runCodexClaudeSkillInstall = (skillName: string, timeoutMs = 120_000) =>
  runCommand('npx', ['-y', 'skills', 'add', SKILLS_PUBLIC_REPO_SLUG, '--skill', skillName], {
    timeoutMs,
  });

const runClawHubCommand = (args: string[], timeoutMs: number) => {
  const invoker = getClawHubInvoker();
  if (!invoker) {
    return null;
  }

  return runCommand(invoker.command, [...invoker.prefix, ...args], { timeoutMs });
};

const summarizeRuns = (
  runs: Array<{ name: string; ok: boolean; timedOut: boolean; stderr: string; code: number | null }>,
  successDetail: string,
): string => {
  if (runs.every((run) => run.ok)) {
    return successDetail;
  }

  return runs
    .map((run) => {
      if (run.ok) {
        return `${run.name}: ok`;
      }

      if (run.timedOut) {
        return `${run.name}: timed out`;
      }

      return `${run.name}: ${run.stderr.trim() || `exit code ${run.code ?? 'unknown'}`}`;
    })
    .join('; ');
};

export const parseSetupAgents = (value: string): SetupAgent[] => {
  const normalized = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const wantsAll = normalized.length === 0 || normalized.includes('all');
  const selected = wantsAll ? ['codex', 'claude', 'openclaw'] : normalized;
  const allowed = new Set<SetupAgent>(['codex', 'claude', 'openclaw']);
  const result: SetupAgent[] = [];

  for (const agent of selected) {
    if (!allowed.has(agent as SetupAgent)) {
      throw Object.assign(
        new Error('Invalid --agents value. Use all|codex|claude|openclaw (comma-separated).'),
        { exitCode: 2 },
      );
    }

    const typedAgent = agent as SetupAgent;
    if (!result.includes(typedAgent)) {
      result.push(typedAgent);
    }
  }

  return result;
};

export const installAgentSkills = (agents: SetupAgent[]): SkillInstallResult[] => {
  const results: SkillInstallResult[] = [];

  if (agents.includes('codex') || agents.includes('claude')) {
    if (!isCommandAvailable('npx')) {
      results.push({
        target: 'codex_claude',
        ok: false,
        skipped: true,
        detail: '`npx` not available on this machine.',
      });
    } else {
      const installs = ANALYTICSCLI_SETUP_SKILL_NAMES.map((skillName) => {
        const install = runCodexClaudeSkillInstall(skillName);
        return {
          name: skillName,
          ok: install.ok,
          timedOut: install.timedOut,
          stderr: install.stderr,
          code: install.code,
        };
      });
      results.push({
        target: 'codex_claude',
        ok: installs.every((install) => install.ok),
        skipped: false,
        detail: summarizeRuns(
          installs,
          `Skills installed/updated from ${formatCommand('npx', ['-y', 'skills', 'add', SKILLS_PUBLIC_REPO_SLUG, '--skill', 'analyticscli-cli'])} and the matching \`analyticscli-ts-sdk\` command.`,
        ),
      });
    }
  }

  if (agents.includes('openclaw')) {
    const invoker = getClawHubInvoker();
    if (!invoker) {
      results.push({
        target: 'openclaw',
        ok: false,
        skipped: true,
        detail: `Neither \`clawhub\` nor \`npx\` is available. Install ClawHub first or use ${CLAWHUB_SITE_URL}.`,
      });
    } else {
      const installs = ANALYTICSCLI_OPENCLAW_SETUP_SKILL_NAMES.map((skillName) => {
        const install = runCommand(invoker.command, [...invoker.prefix, 'install', skillName], {
          timeoutMs: 120_000,
        });
        return {
          name: skillName,
          ok: install.ok,
          timedOut: install.timedOut,
          stderr: install.stderr,
          code: install.code,
        };
      });
      results.push({
        target: 'openclaw',
        ok: installs.every((install) => install.ok),
        skipped: false,
        detail: summarizeRuns(
          installs,
          `Skills installed/updated via ${formatCommand(invoker.command, [...invoker.prefix, 'install', 'analyticscli-cli'])}, the matching \`analyticscli-ts-sdk\` command, and ${formatCommand(invoker.command, [...invoker.prefix, 'install', 'openclaw-growth-engineer'])}.`,
        ),
      });
    }
  }

  return results;
};

export const renderSetupTextSummary = (label: string, result: SetupExecutionResult): string => {
  const lines = [
    label,
    `- Login: ${String(result.login.mode ?? 'skipped')}`,
    `- Auto skill update: ${result.autoSkillUpdate ? 'enabled' : 'disabled'}`,
    `- Config: ${result.configPath}`,
  ];

  for (const entry of result.skillSetup) {
    lines.push(
      `- Skills (${entry.target}): ${entry.ok ? 'ok' : entry.skipped ? 'skipped' : 'failed'}${entry.detail ? ` — ${entry.detail}` : ''}`,
    );
  }

  return lines.join('\n');
};

export const runSetupFlow = async (
  root: { apiUrl?: string; token?: string },
  options: SetupExecutionOptions,
): Promise<SetupExecutionResult> => {
  const initialConfig = await readConfig();
  const apiUrl = (root.apiUrl ?? initialConfig.apiUrl).replace(/\/$/, '');
  const skillResults = options.skipSkills ? [] : installAgentSkills(options.agents);

  let activeConfig = initialConfig;
  let loginResult: SetupLoginResult = {
    ok: true,
    skipped: true,
  };

  if (!options.skipLogin) {
    const providedToken = options.readonlyToken?.trim() || root.token?.trim();

    if (providedToken) {
      const persisted = await persistAuthToken(activeConfig, apiUrl, providedToken);
      activeConfig = persisted.config;
      loginResult = {
        ok: true,
        mode: 'provided_token',
        tokenStorage: persisted.storage,
      };
    } else if (resolveAuthToken(activeConfig, root.token)) {
      loginResult = {
        ok: true,
        mode: 'existing_token',
        tokenStorage: activeConfig.tokenStorage ?? 'config_file',
      };
    } else {
      throw Object.assign(
        new Error(
          'Provide --readonly-token/--token for setup login, or pass --skip-login if you want skills only.',
        ),
        { exitCode: 2 },
      );
    }
  }

  const now = new Date().toISOString();
  const autoSkillUpdateEnabled = options.autoSkillUpdate !== false;
  const finalConfig = {
    ...activeConfig,
    apiUrl,
    setupAgents: options.skipSkills ? activeConfig.setupAgents : normalizeConfiguredAgents(options.agents),
    skillAutoUpdate: autoSkillUpdateEnabled,
    setupCompletedAt: activeConfig.setupCompletedAt ?? now,
    lastSkillSyncAt: options.skipSkills ? activeConfig.lastSkillSyncAt : now,
    lastSeenCliVersion: CLI_VERSION,
    updatedAt: now,
  };
  await writeConfigValue(finalConfig);

  return {
    ok: true,
    apiUrl,
    configPath,
    login: loginResult,
    skillSetup: skillResults,
    autoSkillUpdate: finalConfig.skillAutoUpdate ?? false,
    setupCompletedAt: finalConfig.setupCompletedAt,
  };
};

export const promptYesNo = async (
  rl: PromptClient,
  question: string,
  defaultValue: boolean,
): Promise<boolean> => {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  while (true) {
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }

    process.stdout.write('Please answer with y or n.\n');
  }
};

export const promptRequiredValue = async (rl: PromptClient, question: string): Promise<string> => {
  while (true) {
    const answer = (await rl.question(`${question} `)).trim();
    if (answer) {
      return answer;
    }
    process.stdout.write('Value is required.\n');
  }
};

export const promptLoginMode = async (
  rl: PromptClient,
  hasExistingToken: boolean,
): Promise<'provided' | 'existing' | 'skip'> => {
  while (true) {
    process.stdout.write('\nLogin method:\n');
    process.stdout.write('  1) Readonly token\n');
    if (hasExistingToken) {
      process.stdout.write('  2) Use existing token\n');
      process.stdout.write('  3) Skip for now\n');
    } else {
      process.stdout.write('  2) Skip for now\n');
    }

    const maxChoice = hasExistingToken ? 3 : 2;
    const defaultChoice = hasExistingToken ? '2' : '1';
    const answer = (await rl.question(`Select [1-${maxChoice}] (default ${defaultChoice}): `)).trim();
    const choice = answer || defaultChoice;

    if (choice === '1') {
      return 'provided';
    }
    if (choice === '2' && hasExistingToken) {
      return 'existing';
    }
    if (choice === '2' || choice === '3') {
      return 'skip';
    }

    process.stdout.write('Invalid selection.\n');
  }
};

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const parseSemver = (version: string): ParsedSemver | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
};

const comparePrereleaseIdentifier = (left: string, right: string): number => {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);
  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }
  if (leftIsNumeric) {
    return -1;
  }
  if (rightIsNumeric) {
    return 1;
  }
  return left.localeCompare(right);
};

const compareSemver = (left: string, right: string): number => {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return 0;
  }

  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major;
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor;
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch;

  const leftPre = parsedLeft.prerelease;
  const rightPre = parsedRight.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;

  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const cmp = comparePrereleaseIdentifier(leftPart, rightPart);
    if (cmp !== 0) return cmp;
  }

  return 0;
};

const isVersionNewer = (candidate: string, current: string): boolean => compareSemver(candidate, current) > 0;

const fetchLatestCliVersion = async (): Promise<string | undefined> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, CLI_VERSION_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch('https://registry.npmjs.org/@analyticscli%2fcli', {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      'dist-tags'?: Record<string, unknown>;
    };
    const tags = payload['dist-tags'];
    if (!tags || typeof tags !== 'object') {
      return undefined;
    }

    const preferredTag = CLI_VERSION.includes('-') ? 'preview' : 'latest';
    const preferred = typeof tags[preferredTag] === 'string' ? tags[preferredTag] : undefined;
    const latest = typeof tags.latest === 'string' ? tags.latest : undefined;
    return preferred ?? latest;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
};

const refreshSkills = (skillNames: readonly string[], timeoutMs: number): void => {
  if (isCommandAvailable('npx')) {
    for (const skillName of skillNames) {
      runCodexClaudeSkillInstall(skillName, timeoutMs);
    }
  }

  for (const skillName of skillNames) {
    runClawHubCommand(['update', skillName], timeoutMs);
  }
};

const resolveCliInstallHint = (): string =>
  CLI_VERSION.includes('-')
    ? 'npm install -g @analyticscli/cli@preview'
    : 'npm install -g @analyticscli/cli';

const runCliSelfUpdate = (): { ok: boolean; detail?: string } => {
  if (!isCommandAvailable('npm')) {
    return {
      ok: false,
      detail: '`npm` is not available in your PATH.',
    };
  }

  const packageSpecifier = CLI_VERSION.includes('-') ? '@analyticscli/cli@preview' : '@analyticscli/cli';
  const result = runCommand('npm', ['install', '-g', packageSpecifier], {
    timeoutMs: 120_000,
  });
  if (result.ok) {
    return { ok: true };
  }

  const detail = result.stderr.trim() || result.stdout.trim();
  return {
    ok: false,
    detail: detail || `exit code ${result.code ?? 'unknown'}`,
  };
};

const promptCliUpdateDecision = async (): Promise<'yes' | 'later' | 'never'> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return 'later';
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  try {
    while (true) {
      const answer = (
        await rl.question('Update now? [y]es / [n]ot now / [a]lways skip: ')
      )
        .trim()
        .toLowerCase();

      if (!answer || answer === 'n' || answer === 'no') {
        return 'later';
      }
      if (answer === 'y' || answer === 'yes') {
        return 'yes';
      }
      if (
        answer === 'a' ||
        answer === 'never' ||
        answer === 'not-ask-again' ||
        answer === 'notaskagain'
      ) {
        return 'never';
      }

      process.stderr.write('Please answer with y, n, or a.\n');
    }
  } finally {
    rl.close();
  }
};

export const maybeAutoRefreshSkills = async (commandPath: string): Promise<void> => {
  if (commandPath === 'setup' || commandPath === 'onboard') {
    return;
  }

  const config = await readConfig();
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const hasSetup = Boolean(config.setupCompletedAt);
  const hasCliVersionChanged = config.lastSeenCliVersion !== CLI_VERSION;
  const shouldRefreshOnCliUpgrade = hasSetup && hasCliVersionChanged;

  const lastSyncAtMs = config.lastSkillSyncAt ? Date.parse(config.lastSkillSyncAt) : 0;
  const shouldRefreshPeriodically =
    Boolean(config.skillAutoUpdate) &&
    (!Number.isFinite(lastSyncAtMs) || nowMs - lastSyncAtMs >= SKILL_SYNC_INTERVAL_MS);

  let didRefresh = false;
  if (shouldRefreshOnCliUpgrade || shouldRefreshPeriodically) {
    refreshSkills(resolveAutoRefreshSkillNames(config.setupAgents), SKILL_SYNC_TIMEOUT_MS);
    didRefresh = true;
  }

  if (!hasCliVersionChanged && !didRefresh) {
    return;
  }

  await writeConfigValue({
    ...config,
    lastSeenCliVersion: CLI_VERSION,
    ...(didRefresh ? { lastSkillSyncAt: now } : {}),
    updatedAt: now,
  });
};

export const maybeNotifyCliUpdate = async (input: {
  commandPath: string;
  format: OutputFormat;
  quiet?: boolean;
}): Promise<void> => {
  if (input.commandPath === 'setup' || input.commandPath === 'onboard') {
    return;
  }

  const config = await readConfig();
  const nowMs = Date.now();
  const lastCheckedMs = config.lastCliVersionCheckAt ? Date.parse(config.lastCliVersionCheckAt) : 0;
  if (Number.isFinite(lastCheckedMs) && nowMs - lastCheckedMs < CLI_VERSION_CHECK_INTERVAL_MS) {
    return;
  }

  const latestVersion = await fetchLatestCliVersion();
  const now = new Date(nowMs).toISOString();
  const baseConfig = {
    ...config,
    lastCliVersionCheckAt: now,
    updatedAt: now,
  };

  if (latestVersion && isVersionNewer(latestVersion, CLI_VERSION)) {
    if (config.suppressedCliUpdateVersion === latestVersion) {
      await writeConfigValue(baseConfig);
      return;
    }

    const installHint = resolveCliInstallHint();
    const updateMessage = `A newer AnalyticsCLI CLI version is available (${latestVersion}; current ${CLI_VERSION}).`;
    const canPromptInteractively =
      input.format === 'text' &&
      !input.quiet &&
      process.stdin.isTTY &&
      process.stderr.isTTY;

    if (canPromptInteractively) {
      process.stderr.write(`${updateMessage}\n`);
      const decision = await promptCliUpdateDecision();
      if (decision === 'never') {
        await writeConfigValue({
          ...baseConfig,
          suppressedCliUpdateVersion: latestVersion,
        });
        return;
      }

      if (decision === 'yes') {
        const updateResult = runCliSelfUpdate();
        if (updateResult.ok) {
          process.stderr.write('CLI updated successfully. Re-run your command to use the new version.\n');
        } else {
          process.stderr.write(`Automatic update failed. Run manually: ${installHint}\n`);
          if (updateResult.detail) {
            process.stderr.write(`${updateResult.detail}\n`);
          }
        }

        await writeConfigValue({
          ...baseConfig,
          lastCliVersionNotified: latestVersion,
        });
        return;
      }

      await writeConfigValue(baseConfig);
      return;
    }

    if (input.format === 'text' && !input.quiet && config.lastCliVersionNotified !== latestVersion) {
      process.stderr.write(`${updateMessage} Update with: ${installHint}\n`);
      await writeConfigValue({
        ...baseConfig,
        lastCliVersionNotified: latestVersion,
      });
      return;
    }

    await writeConfigValue(baseConfig);
    return;
  }

  if (latestVersion && !isVersionNewer(latestVersion, CLI_VERSION) && config.lastCliVersionNotified) {
    await writeConfigValue({
      ...baseConfig,
      lastCliVersionNotified: undefined,
    });
    return;
  }

  await writeConfigValue(baseConfig);
};
