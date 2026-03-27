#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import type { CliCommandContext, RootCliOptions } from './commands/context.js';
import { registerDevCommands } from './commands/dev.js';
import { registerEventCommands } from './commands/events.js';
import { registerFeedbackCommands } from './commands/feedback.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerQueryCommands } from './commands/queries/index.js';
import {
  CLI_DEV_COMMANDS_ENABLED,
  CLI_ANON_ID,
  CLI_SESSION_ID,
  CLI_VERSION,
  LEGACY_SELF_TRACKING_ENABLED,
  LEGACY_SELF_TRACKING_ENDPOINT,
  SELF_TRACKING_ENABLED,
  env,
} from './constants.js';
import { readConfig, resolveAuthToken } from './config-store.js';
import { resolveProjectId as resolveProjectIdWithFallback } from './project-selection.js';
import { maybeAutoRefreshSkills, maybeNotifyCliUpdate } from './setup.js';

let activeCommandPath = 'unknown';
let activeCommandStartMs = Date.now();

type SelfTrackingRequestOptions = {
  apiUrl?: string;
  token?: string;
  projectId?: string;
};

const resolveCommandPath = (command: Command): string => {
  const names: string[] = [];
  let cursor: Command | null = command;

  while (cursor) {
    const name = cursor.name();
    if (name && name !== 'analyticscli') {
      names.unshift(name);
    }
    cursor = cursor.parent ?? null;
  }

  return names.join(' ') || 'unknown';
};

const sendLegacySelfTrackingEvent = async (
  eventName: string,
  properties: Record<string, unknown>,
): Promise<void> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 1200);
  try {
    await fetch(`${LEGACY_SELF_TRACKING_ENDPOINT}/v1/collect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': String(env.ANALYTICSCLI_SELF_TRACKING_API_KEY),
      },
      keepalive: true,
      signal: controller.signal,
      body: JSON.stringify({
        projectId: String(env.ANALYTICSCLI_SELF_TRACKING_PROJECT_ID),
        sentAt: new Date().toISOString(),
        events: [
          {
            eventId: `${eventName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            eventName,
            ts: new Date().toISOString(),
            sessionId: CLI_SESSION_ID,
            anonId: CLI_ANON_ID,
            properties: {
              ...properties,
              platform: env.ANALYTICSCLI_SELF_TRACKING_PLATFORM,
              nodeVersion: process.version,
              cliVersion: CLI_VERSION,
            },
            platform: env.ANALYTICSCLI_SELF_TRACKING_PLATFORM,
            projectSurface: 'cli',
            appVersion: CLI_VERSION,
            type: 'track',
          },
        ],
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const sendApiSelfTrackingEvent = async (
  eventName: string,
  properties: Record<string, unknown>,
  options: SelfTrackingRequestOptions,
): Promise<void> => {
  const config = await readConfig();
  const token = resolveAuthToken(config, options.token?.trim());
  if (!token) {
    return;
  }

  const apiUrl = (options.apiUrl?.trim() || config.apiUrl || env.ANALYTICSCLI_API_URL).replace(/\/$/, '');
  const projectId =
    options.projectId?.trim() ||
    env.ANALYTICSCLI_SELF_TRACKING_PROJECT_ID?.trim() ||
    config.selectedProjectId ||
    undefined;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 1200);

  try {
    await fetch(`${apiUrl}/v1/telemetry/cli`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      keepalive: true,
      signal: controller.signal,
      body: JSON.stringify({
        eventName,
        projectId,
        sessionId: CLI_SESSION_ID,
        anonId: CLI_ANON_ID,
        sentAt: new Date().toISOString(),
        properties: {
          ...properties,
          platform: env.ANALYTICSCLI_SELF_TRACKING_PLATFORM,
          nodeVersion: process.version,
          cliVersion: CLI_VERSION,
        },
      }),
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const emitSelfTrackingEvent = async (
  eventName: string,
  properties: Record<string, unknown>,
  options: SelfTrackingRequestOptions,
): Promise<void> => {
  if (!SELF_TRACKING_ENABLED) {
    return;
  }

  try {
    if (LEGACY_SELF_TRACKING_ENABLED) {
      await sendLegacySelfTrackingEvent(eventName, properties);
      return;
    }
    await sendApiSelfTrackingEvent(eventName, properties, options);
  } catch {
    // Self-tracking must never break CLI behavior.
  }
};

const withErrorHandling = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    const typed = error as Error & { exitCode?: number; payload?: unknown };
    await emitSelfTrackingEvent('cli:command_failed', {
      command: activeCommandPath,
      durationMs: Date.now() - activeCommandStartMs,
      exitCode: typed.exitCode ?? 4,
    }, {
      apiUrl: getRootOptions().apiUrl,
      token: getRootOptions().token,
      projectId: getRootOptions().project,
    });
    const payload = typed.payload ?? {
      error: {
        message: typed.message,
      },
    };

    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = typed.exitCode ?? 4;
  }
};

const program = new Command();
program
  .name('analyticscli')
  .description('Agent-friendly AnalyticsCLI CLI')
  .option('--api-url <url>', 'API base URL')
  .option('--token <token>', 'Override auth token for this call')
  .option('--project <id>', 'Default project ID for this command invocation')
  .option('--format <format>', 'Output format json|text', 'json')
  .option('--include-debug', 'Include development/debug events in query/export commands', false)
  .option('--quiet', 'Reduce text output noise', false);

const getRootOptions = (): RootCliOptions => program.opts<RootCliOptions>();
const includeDebugFlag = (): boolean => Boolean(getRootOptions().includeDebug);
const resolveProjectId = async (projectOption?: string): Promise<string> => {
  const root = getRootOptions();
  const resolved = await resolveProjectIdWithFallback({
    explicitProjectId: projectOption,
    rootProjectId: root.project,
    apiUrl: root.apiUrl,
    token: root.token,
    allowInteractiveSelection: true,
  });
  return resolved.projectId;
};

const context: CliCommandContext = {
  program,
  withErrorHandling,
  getRootOptions,
  includeDebugFlag,
  resolveProjectId,
};

program.hook('preAction', async (_thisCommand, actionCommand) => {
  activeCommandPath = resolveCommandPath(actionCommand);
  activeCommandStartMs = Date.now();
  const root = getRootOptions();
  await maybeAutoRefreshSkills(activeCommandPath).catch(() => {
    // Auto-refresh is best effort.
  });
  await maybeNotifyCliUpdate({
    commandPath: activeCommandPath,
    format: root.format,
    quiet: root.quiet,
  }).catch(() => {
    // Update check is best effort.
  });
  await emitSelfTrackingEvent('cli:command_started', {
    command: activeCommandPath,
  }, {
    apiUrl: root.apiUrl,
    token: root.token,
    projectId: root.project,
  });
});

program.hook('postAction', async (_thisCommand, actionCommand) => {
  const root = getRootOptions();
  await emitSelfTrackingEvent('cli:command_succeeded', {
    command: resolveCommandPath(actionCommand),
    durationMs: Date.now() - activeCommandStartMs,
  }, {
    apiUrl: root.apiUrl,
    token: root.token,
    projectId: root.project,
  });
});

registerAuthCommands(context);
registerProjectCommands(context);
registerQueryCommands(context);
registerFeedbackCommands(context);
registerEventCommands(context);
if (CLI_DEV_COMMANDS_ENABLED) {
  registerDevCommands(context);
}

program.parseAsync(process.argv).catch(async (error) => {
  const typed = error as Error;
  const root = getRootOptions();
  await emitSelfTrackingEvent('cli:parse_failed', {
    command: activeCommandPath,
    durationMs: Date.now() - activeCommandStartMs,
  }, {
    apiUrl: root.apiUrl,
    token: root.token,
    projectId: root.project,
  });
  process.stderr.write(`${JSON.stringify({ error: { message: typed.message } })}\n`);
  process.exitCode = 4;
});
