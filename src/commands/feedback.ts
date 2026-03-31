import { parseJsonObjectOption, print } from '../analytics-utils.js';
import { CLI_ANON_ID, CLI_VERSION, env } from '../constants.js';
import { mapStatusToExitCode } from '../http.js';
import type { CliCommandContext } from './context.js';

const FEEDBACK_API_HEADER = 'x-feedback-key';

const sanitizeMetadataKey = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9._-]/g, '_').slice(0, 40);
  return normalized.length > 0 ? normalized : 'meta';
};

const normalizeMetadataValue = (value: unknown): string | number | boolean | null => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const resolveExternalFeedbackConfig = (options: {
  serviceUrl?: string;
  serviceKey?: string;
  appId?: string;
  userId?: string;
}) => {
  const serviceUrl = String(options.serviceUrl ?? env.ANALYTICSCLI_FEEDBACK_SERVICE_URL ?? '').replace(/\/$/, '');
  const serviceKey = String(options.serviceKey ?? env.ANALYTICSCLI_FEEDBACK_SERVICE_API_KEY ?? '').trim();
  const appId = String(options.appId ?? env.ANALYTICSCLI_FEEDBACK_SERVICE_APP_ID ?? '').trim();
  const userId = String(options.userId ?? env.ANALYTICSCLI_FEEDBACK_USER_ID ?? CLI_ANON_ID).trim();

  if (!serviceUrl || !serviceKey || !appId) {
    throw Object.assign(
      new Error(
        'Missing feedback service config. Set ANALYTICSCLI_FEEDBACK_SERVICE_URL, ANALYTICSCLI_FEEDBACK_SERVICE_API_KEY and ANALYTICSCLI_FEEDBACK_SERVICE_APP_ID.',
      ),
      { exitCode: 2 },
    );
  }

  if (!userId) {
    throw Object.assign(new Error('Missing feedback user id. Pass --user-id or set ANALYTICSCLI_FEEDBACK_USER_ID.'), {
      exitCode: 2,
    });
  }

  return {
    serviceUrl,
    serviceKey,
    appId,
    userId,
  };
};

export const registerFeedbackCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions } = context;

  const feedback = program.command('feedback').description('Send tenant feedback about AnalyticsCLI');

  feedback
    .command('submit')
    .description('Submit tenant product feedback about AnalyticsCLI')
    .requiredOption('--message <text>', 'Feedback message')
    .option('--rating <n>', 'Optional rating 1-5')
    .option('--category <type>', 'bug|feature|ux|performance|other', 'other')
    .option('--context <text>', 'Optional context, e.g. what failed')
    .option('--meta <json>', 'Optional JSON object with additional fields')
    .option('--location <value>', 'Location identifier, e.g. dashboard/settings', 'analyticscli-cli')
    .option('--surface <value>', 'Surface identifier', 'analyticscli-cli')
    .option('--service-url <url>', 'Feedback service URL (defaults to ANALYTICSCLI_FEEDBACK_SERVICE_URL)')
    .option('--service-key <key>', 'Feedback service API key (defaults to ANALYTICSCLI_FEEDBACK_SERVICE_API_KEY)')
    .option('--app-id <id>', 'Feedback app id (defaults to ANALYTICSCLI_FEEDBACK_SERVICE_APP_ID)')
    .option('--user-id <id>', 'Feedback user id (defaults to ANALYTICSCLI_FEEDBACK_USER_ID or CLI anon id)')
    .action(
      async (options: {
        message: string;
        rating?: string;
        category?: string;
        context?: string;
        meta?: string;
        location?: string;
        surface?: string;
        serviceUrl?: string;
        serviceKey?: string;
        appId?: string;
        userId?: string;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const { serviceUrl, serviceKey, appId, userId } = resolveExternalFeedbackConfig(options);

          const category = String(options.category ?? 'other').toLowerCase();
          if (!['bug', 'feature', 'ux', 'performance', 'other'].includes(category)) {
            throw Object.assign(
              new Error('Invalid --category. Use bug|feature|ux|performance|other'),
              { exitCode: 2 },
            );
          }

          let rating: number | undefined;
          if (options.rating !== undefined) {
            const parsedRating = Number(options.rating);
            if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
              throw Object.assign(new Error('Invalid --rating. Use an integer 1-5.'), { exitCode: 2 });
            }
            rating = parsedRating;
          }

          const message = String(options.message).trim();
          if (!message) {
            throw Object.assign(new Error('Feedback message must not be empty.'), { exitCode: 2 });
          }

          const contextText = options.context ? String(options.context).trim() : '';
          const metadataOption = parseJsonObjectOption(options.meta as string | undefined, '--meta');
          const metadata: Record<string, string | number | boolean | null> = {
            category,
            cliVersion: CLI_VERSION,
            ...(rating !== undefined ? { rating } : {}),
            ...(contextText ? { context: contextText } : {}),
            ...(root.apiUrl ? { apiUrl: root.apiUrl } : {}),
          };

          for (const [key, rawValue] of Object.entries(metadataOption)) {
            metadata[`meta.${sanitizeMetadataKey(key)}`] = normalizeMetadataValue(rawValue);
          }

          const response = await fetch(`${serviceUrl}/v1/feedback`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [FEEDBACK_API_HEADER]: serviceKey,
            },
            body: JSON.stringify({
              appId,
              userId,
              feedback: message,
              location: String(options.location ?? 'analyticscli-cli').trim() || 'analyticscli-cli',
              appSurface: String(options.surface ?? 'analyticscli-cli').trim() || 'analyticscli-cli',
              metadata,
            }),
          });

          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            const message =
              typeof payload.error === 'string'
                ? payload.error
                : `Feedback service request failed with status ${response.status}`;
            const error = Object.assign(new Error(message), {
              exitCode: mapStatusToExitCode(response.status),
              payload,
            });
            throw error;
          }

          if (root.format === 'text') {
            print('text', 'Feedback an den externen Feedback-Service gesendet.');
            return;
          }

          print(root.format, {
            ok: true,
            delivery: 'external-feedback-service',
            serviceUrl,
            appId,
            userId,
            category,
            ...(rating !== undefined ? { rating } : {}),
            response: payload,
          });
        });
      },
    );
};
