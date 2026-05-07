import { createInterface } from 'node:readline/promises';
import { print } from '../analytics-utils.js';
import { configPath, persistAuthToken, readConfig, resolveApiUrl, resolveAuthToken } from '../config-store.js';
import { CLAWHUB_SITE_URL } from '../constants.js';
import { isCommandAvailable, openExternalUrl } from '../shell.js';
import {
  parseSetupAgents,
  promptLoginMode,
  promptRequiredValue,
  promptYesNo,
  renderSetupTextSummary,
  runSetupFlow,
} from '../setup.js';
import type { SetupAgent } from '../types.js';
import type { CliCommandContext } from './context.js';

type TokenOptionInput = {
  readonlyToken?: string;
};

const resolveProvidedToken = (options: TokenOptionInput, rootToken?: string): string | undefined =>
  (options.readonlyToken ?? rootToken)?.trim() || undefined;

export const registerAuthCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions } = context;

  program
    .command('login')
    .description('Store a readonly token for CLI/API access')
    .option('--readonly-token <token>', 'Readonly token to store directly (non-interactive)')
    .action(async (options: TokenOptionInput) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const config = await readConfig();
        const apiUrl = resolveApiUrl(config, root.apiUrl);

        let directToken = resolveProvidedToken(options, root.accessToken);

        if (!directToken) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw Object.assign(
              new Error('Run `analyticscli login` in an interactive terminal or provide --readonly-token.'),
              { exitCode: 2 },
            );
          }

          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            directToken = await promptRequiredValue(
              rl,
              'Paste readonly CLI token from Dashboard -> API Keys:',
            );
          } finally {
            rl.close();
          }
        }

        const now = new Date().toISOString();
        const persisted = await persistAuthToken(config, root.apiUrl ?? config.apiUrl, directToken);

        print(root.format, {
          ok: true,
          mode: 'provided_token',
          apiUrl,
          tokenStorage: persisted.storage,
          configPath,
          updatedAt: now,
        });
      });
    });

  program
    .command('setup')
    .description('One-time setup: install skills, optionally persist a readonly CLI token, and enable optional auto skill refresh')
    .option('--readonly-token <token>', 'Readonly CLI token to persist during setup')
    .option('--skip-login', 'Skip login step', false)
    .option('--skip-skills', 'Skip skill installation step', false)
    .option('--agents <targets>', 'all|codex|claude|openclaw (comma-separated)', 'all')
    .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
    .action(
      async (options: {
        readonlyToken?: string;
        skipLogin?: boolean;
        skipSkills?: boolean;
        agents?: string;
        autoSkillUpdate?: boolean;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const agents = parseSetupAgents(String(options.agents ?? 'all'));
          const result = await runSetupFlow(root, {
            accessToken: resolveProvidedToken(options),
            skipLogin: options.skipLogin,
            skipSkills: options.skipSkills,
            agents,
            autoSkillUpdate: options.autoSkillUpdate,
          });

          if (root.format === 'text') {
            print('text', renderSetupTextSummary('Setup complete.', result));
            return;
          }

          print(root.format, result);
        });
      },
    );

  program
    .command('onboard')
    .description('Interactive onboarding: choose skill install targets and optionally connect CLI query access')
    .option('--readonly-token <token>', 'Readonly CLI token to persist during onboarding')
    .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
    .action(
      async (options: {
        readonlyToken?: string;
        autoSkillUpdate?: boolean;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();

          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw Object.assign(
              new Error(
                '`onboard` requires an interactive terminal. Use `analyticscli setup` for non-interactive flows.',
              ),
              { exitCode: 2 },
            );
          }

          const selectedAgents: SetupAgent[] = [];
          let accessToken = resolveProvidedToken(options);
          let skipLogin = false;
          let autoSkillUpdate = options.autoSkillUpdate;
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          try {
            process.stdout.write('AnalyticsCLI onboarding\n');
            process.stdout.write(
              'This flow installs agent skills and can connect this CLI to your AnalyticsCLI account.\n\n',
            );

            const installCodexClaude = await promptYesNo(
              rl,
              'Install AnalyticsCLI skills for Codex/Claude Code from `wotaso/analyticscli-skills`?',
              true,
            );
            if (installCodexClaude) {
              selectedAgents.push('codex', 'claude');
            }

            const installOpenclaw = await promptYesNo(
              rl,
              'Install the canonical OpenClaw Growth Engineer skill from ClawHub?',
              false,
            );
            if (installOpenclaw) {
              selectedAgents.push('openclaw');
              if (!isCommandAvailable('clawhub') && !isCommandAvailable('npx')) {
                process.stdout.write('\nNeither `clawhub` nor `npx` is installed on this machine.\n');
                const openSkillPage = await promptYesNo(
                  rl,
                  `Open ClawHub now (${CLAWHUB_SITE_URL})?`,
                  true,
                );
                if (openSkillPage) {
                  const openResult = openExternalUrl(CLAWHUB_SITE_URL);
                  if (!openResult) {
                    process.stdout.write(
                      `Could not auto-open browser. Open this URL manually: ${CLAWHUB_SITE_URL}\n`,
                    );
                  } else if (!openResult.ok) {
                    process.stdout.write(
                      `Failed to open browser automatically. Open this URL manually: ${CLAWHUB_SITE_URL}\n`,
                    );
                  }
                }
              }
            }

            if (!accessToken) {
              const config = await readConfig();
              const hasExistingToken = Boolean(resolveAuthToken(config, root.accessToken));
              const loginMode = await promptLoginMode(rl, hasExistingToken);

              if (loginMode === 'provided') {
                accessToken = await promptRequiredValue(
                  rl,
                  'Paste readonly CLI token from Dashboard -> API Keys:',
                );
              } else if (loginMode === 'skip') {
                skipLogin = true;
              }
            }

            if (autoSkillUpdate !== false) {
              autoSkillUpdate = await promptYesNo(rl, 'Enable daily automatic skill refresh?', true);
            }
          } finally {
            rl.close();
          }

          const shouldSkipSkills = selectedAgents.length === 0;
          const result = await runSetupFlow(root, {
            accessToken,
            skipLogin,
            skipSkills: shouldSkipSkills,
            agents: shouldSkipSkills ? [] : selectedAgents,
            autoSkillUpdate,
          });

          if (root.format === 'text') {
            print('text', renderSetupTextSummary('Onboarding complete.', result));
            return;
          }

          print(root.format, result);
        });
      },
    );
};
