import { createInterface } from 'node:readline/promises';
import { print } from '../analytics-utils.js';
import { configPath, persistAuthToken, readConfig, resolveAuthToken } from '../config-store.js';
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

export const registerAuthCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions } = context;

  program
    .command('login')
    .description('Store an access token for CLI/API access')
    .option('--access-token <token>', 'Access token to store directly')
    .action(async (options: { accessToken?: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const config = await readConfig();
        const apiUrl = (root.apiUrl ?? config.apiUrl).replace(/\/$/, '');

        const directToken = options.accessToken?.trim() ?? root.accessToken?.trim();

        if (!directToken) {
          throw Object.assign(new Error('Provide --access-token'), { exitCode: 2 });
        }

        const now = new Date().toISOString();
        const persisted = await persistAuthToken(config, apiUrl, directToken);

        print(root.format, {
          ok: true,
          mode: 'provided_token',
          tokenStorage: persisted.storage,
          configPath,
          updatedAt: now,
        });
      });
    });

  program
    .command('setup')
    .description('One-time setup: install skills, optionally persist an access token, and enable optional auto skill refresh')
    .option('--access-token <token>', 'Access token to persist during setup')
    .option('--skip-login', 'Skip login step', false)
    .option('--skip-skills', 'Skip skill installation step', false)
    .option('--agents <targets>', 'all|codex|claude|openclaw (comma-separated)', 'all')
    .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
    .action(
      async (options: {
        accessToken?: string;
        skipLogin?: boolean;
        skipSkills?: boolean;
        agents?: string;
        autoSkillUpdate?: boolean;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const agents = parseSetupAgents(String(options.agents ?? 'all'));
          const result = await runSetupFlow(root, {
            accessToken: options.accessToken,
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
    .description('Interactive onboarding: choose skill install targets and optionally store an access token')
    .option('--access-token <token>', 'Access token to persist during onboarding')
    .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
    .action(
      async (options: {
        accessToken?: string;
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
          let accessToken = options.accessToken?.trim();
          let skipLogin = false;
          let autoSkillUpdate = options.autoSkillUpdate;
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          try {
            process.stdout.write('AnalyticsCLI onboarding\n');
            process.stdout.write('This flow installs skills and configures login.\n\n');

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
              'Install the canonical ClawHub skill (`ai-product-manager`)?',
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
                accessToken = await promptRequiredValue(rl, 'Enter access token:');
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
