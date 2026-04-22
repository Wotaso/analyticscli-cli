import { parseJsonObjectOption, print } from '../analytics-utils.js';
import { CLI_VERSION } from '../constants.js';
import { requestApi } from '../http.js';
import type { CliCommandContext } from './context.js';

type FeedbackCategory = 'bug' | 'feature' | 'ux' | 'performance' | 'other';

type FeedbackMessageItem = {
  id: string;
  source: string;
  message: string;
  rating: number | null;
  category: string | null;
  context: string | null;
  surface: string | null;
  locationId: string | null;
  originName: string | null;
  appId: string | null;
  externalUserId: string | null;
  actorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type FeedbackListResponse = {
  items: FeedbackMessageItem[];
  count: number;
  timeRange: {
    since: string;
    until: string;
  };
};

type FeedbackSummaryItem = {
  id: string;
  title: string;
  count: number;
  category: string | null;
  originName: string | null;
  surface: string | null;
  latestMessage: string;
  latestCreatedAt: string;
  averageRating: number | null;
  locations: Array<{
    locationId: string;
    count: number;
  }>;
  sources: string[];
  examples: string[];
};

type FeedbackSummaryResponse = {
  generatedAt: string;
  count: number;
  timeRange: {
    since: string;
    until: string;
  };
  items: FeedbackSummaryItem[];
};

const FEEDBACK_CATEGORIES: FeedbackCategory[] = ['bug', 'feature', 'ux', 'performance', 'other'];

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

const normalizeCategory = (value: string | undefined): FeedbackCategory => {
  const normalized = String(value ?? 'other').trim().toLowerCase() as FeedbackCategory;
  if (!FEEDBACK_CATEGORIES.includes(normalized)) {
    throw Object.assign(new Error('Invalid --category. Use bug|feature|ux|performance|other'), {
      exitCode: 2,
    });
  }
  return normalized;
};

const parseRating = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw Object.assign(new Error('Invalid --rating. Use an integer 1-5.'), { exitCode: 2 });
  }
  return parsed;
};

const normalizeDuration = (value: string | undefined, fallback: string): string => {
  const normalized = String(value ?? fallback).trim();
  if (!/^[0-9]+[dhm]$/.test(normalized)) {
    throw Object.assign(new Error('Invalid duration. Use values like 24h, 7d, or 30m.'), {
      exitCode: 2,
    });
  }
  return normalized;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const buildQueryString = (input: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
};

const extractFeedbackTitle = (message: string): string => {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Untitled feedback';
  }

  const sentence = normalized.split(/[.!?]/)[0]?.trim() ?? normalized;
  const title = sentence.length > 96 ? `${sentence.slice(0, 93).trimEnd()}...` : sentence;
  return title || 'Untitled feedback';
};

const normalizeTitleKey = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const buildFeedbackSummary = (payload: FeedbackListResponse): FeedbackSummaryResponse => {
  const grouped = new Map<
    string,
    FeedbackSummaryItem & {
      ratingSum: number;
      ratingCount: number;
      locationsMap: Map<string, number>;
      examplesSet: Set<string>;
      sourcesSet: Set<string>;
    }
  >();

  for (const item of payload.items) {
    const title = extractFeedbackTitle(item.message);
    const key = [
      normalizeTitleKey(title),
      normalizeOptionalString(item.category) ?? 'other',
      normalizeOptionalString(item.originName) ?? 'unknown',
    ].join('|');
    const current = grouped.get(key) ?? {
      id: key.replace(/[^a-z0-9|_-]/gi, '_'),
      title,
      count: 0,
      category: item.category,
      originName: item.originName,
      surface: item.surface,
      latestMessage: item.message,
      latestCreatedAt: item.createdAt,
      averageRating: null,
      locations: [],
      sources: [],
      examples: [],
      ratingSum: 0,
      ratingCount: 0,
      locationsMap: new Map<string, number>(),
      examplesSet: new Set<string>(),
      sourcesSet: new Set<string>(),
    };

    current.count += 1;
    if (item.rating !== null && Number.isFinite(item.rating)) {
      current.ratingSum += item.rating;
      current.ratingCount += 1;
    }
    if (new Date(item.createdAt).getTime() >= new Date(current.latestCreatedAt).getTime()) {
      current.latestCreatedAt = item.createdAt;
      current.latestMessage = item.message;
      current.surface = item.surface ?? current.surface;
      current.originName = item.originName ?? current.originName;
      current.category = item.category ?? current.category;
    }
    if (item.locationId) {
      current.locationsMap.set(item.locationId, (current.locationsMap.get(item.locationId) ?? 0) + 1);
    }
    current.sourcesSet.add(item.source);
    if (current.examplesSet.size < 3) {
      current.examplesSet.add(item.message);
    }
    grouped.set(key, current);
  }

  const items = [...grouped.values()]
    .map((item) => ({
      id: item.id,
      title: item.title,
      count: item.count,
      category: item.category,
      originName: item.originName,
      surface: item.surface,
      latestMessage: item.latestMessage,
      latestCreatedAt: item.latestCreatedAt,
      averageRating:
        item.ratingCount > 0 ? Number((item.ratingSum / item.ratingCount).toFixed(2)) : null,
      locations: [...item.locationsMap.entries()]
        .map(([locationId, count]) => ({ locationId, count }))
        .sort((left, right) => right.count - left.count || left.locationId.localeCompare(right.locationId)),
      sources: [...item.sourcesSet].sort(),
      examples: [...item.examplesSet],
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        new Date(right.latestCreatedAt).getTime() - new Date(left.latestCreatedAt).getTime() ||
        left.title.localeCompare(right.title),
    );

  return {
    generatedAt: new Date().toISOString(),
    count: payload.count,
    timeRange: payload.timeRange,
    items,
  };
};

const renderFeedbackListText = (payload: FeedbackListResponse): string => {
  if (payload.items.length === 0) {
    return `No feedback messages found for ${payload.timeRange.since} -> ${payload.timeRange.until}.`;
  }

  const lines = [
    `Feedback messages (${payload.count}) for ${payload.timeRange.since} -> ${payload.timeRange.until}:`,
  ];
  for (const item of payload.items) {
    const meta = [item.category, item.originName, item.locationId].filter(Boolean).join(' | ');
    lines.push(
      `- ${item.createdAt} ${meta ? `[${meta}] ` : ''}${item.message.replace(/\s+/g, ' ').trim()}`,
    );
  }
  return lines.join('\n');
};

const renderFeedbackSummaryText = (payload: FeedbackSummaryResponse): string => {
  if (payload.items.length === 0) {
    return `No feedback themes found for ${payload.timeRange.since} -> ${payload.timeRange.until}.`;
  }

  const lines = [
    `Feedback themes (${payload.items.length}) for ${payload.timeRange.since} -> ${payload.timeRange.until}:`,
  ];
  for (const item of payload.items) {
    const meta = [item.category, item.originName].filter(Boolean).join(' | ');
    lines.push(`- ${item.title} (${item.count})${meta ? ` [${meta}]` : ''}`);
  }
  return lines.join('\n');
};

export const registerFeedbackCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions, resolveProjectId } = context;

  const feedback = program.command('feedback').description('Submit and review project feedback');

  feedback
    .command('submit')
    .description('Submit project feedback into the AnalyticsCLI feedback store')
    .requiredOption('--message <text>', 'Feedback message')
    .option('--project <id>', 'Project id (defaults to selected project)')
    .option('--rating <n>', 'Optional rating 1-5')
    .option('--category <type>', 'bug|feature|ux|performance|other', 'other')
    .option('--context <text>', 'Optional context, e.g. what failed')
    .option('--origin-name <value>', 'Human-readable product origin label', 'analyticscli cli')
    .option('--location-id <value>', 'Location identifier, e.g. dashboard/settings', 'analyticscli-cli')
    .option('--surface <value>', 'Surface identifier', 'analyticscli-cli')
    .option('--meta <json>', 'Optional JSON object with additional fields')
    .action(
      async (options: {
        project?: string;
        message: string;
        rating?: string;
        category?: string;
        context?: string;
        originName?: string;
        locationId?: string;
        surface?: string;
        meta?: string;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const category = normalizeCategory(options.category);
          const rating = parseRating(options.rating);
          const message = String(options.message).trim();
          if (!message) {
            throw Object.assign(new Error('Feedback message must not be empty.'), { exitCode: 2 });
          }

          const contextText = normalizeOptionalString(options.context);
          const metadataOption = parseJsonObjectOption(options.meta, '--meta');
          const metadata: Record<string, string | number | boolean | null> = {
            cliVersion: CLI_VERSION,
            ...(contextText ? { context: contextText } : {}),
            ...(root.apiUrl ? { apiUrl: root.apiUrl } : {}),
          };
          for (const [key, rawValue] of Object.entries(metadataOption)) {
            metadata[`meta.${sanitizeMetadataKey(key)}`] = normalizeMetadataValue(rawValue);
          }

          const payload = (await requestApi(
            'POST',
            `/v1/projects/${projectId}/feedback`,
            {
              source: 'cli',
              message,
              category,
              ...(rating !== undefined ? { rating } : {}),
              ...(contextText ? { context: contextText } : {}),
              originName: normalizeOptionalString(options.originName) ?? 'analyticscli cli',
              locationId: normalizeOptionalString(options.locationId) ?? 'analyticscli-cli',
              surface: normalizeOptionalString(options.surface) ?? 'analyticscli-cli',
              metadata,
            },
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          )) as {
            ok: boolean;
            delivery: string;
            item?: FeedbackMessageItem;
          };

          if (root.format === 'text') {
            print('text', `Feedback stored for project ${projectId}.`);
            return;
          }

          print(root.format, payload);
        });
      },
    );

  feedback
    .command('list')
    .description('List recent feedback messages for a project')
    .option('--project <id>', 'Project id (defaults to selected project)')
    .option('--last <duration>', 'Relative lookback, e.g. 7d or 24h', '30d')
    .option('--since <iso>', 'Explicit inclusive start timestamp')
    .option('--until <iso>', 'Explicit exclusive end timestamp')
    .option('--limit <n>', 'Maximum number of feedback messages', '50')
    .option('--source <value>', 'Filter by source, e.g. sdk|dashboard|cli')
    .option('--origin-name <value>', 'Filter by origin label')
    .option('--location-id <value>', 'Filter by location id')
    .action(
      async (options: {
        project?: string;
        last?: string;
        since?: string;
        until?: string;
        limit?: string;
        source?: string;
        originName?: string;
        locationId?: string;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const limit = Number.parseInt(String(options.limit ?? '50'), 10);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw Object.assign(new Error('Invalid --limit. Use an integer between 1 and 200.'), {
              exitCode: 2,
            });
          }

          const query = buildQueryString({
            limit,
            ...(options.since ? { since: options.since.trim() } : {}),
            ...(options.until ? { until: options.until.trim() } : {}),
            ...(!options.since && !options.until
              ? { last: normalizeDuration(options.last, '30d') }
              : {}),
            source: normalizeOptionalString(options.source),
            originName: normalizeOptionalString(options.originName),
            locationId: normalizeOptionalString(options.locationId),
          });

          const payload = (await requestApi(
            'GET',
            `/v1/projects/${projectId}/feedback/messages${query}`,
            undefined,
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          )) as FeedbackListResponse;

          if (root.format === 'text') {
            print('text', renderFeedbackListText(payload));
            return;
          }

          print(root.format, payload);
        });
      },
    );

  feedback
    .command('summary')
    .description('Summarize recent feedback themes for a project')
    .option('--project <id>', 'Project id (defaults to selected project)')
    .option('--last <duration>', 'Relative lookback, e.g. 7d or 24h', '30d')
    .option('--since <iso>', 'Explicit inclusive start timestamp')
    .option('--until <iso>', 'Explicit exclusive end timestamp')
    .option('--limit <n>', 'Maximum number of raw feedback messages to summarize', '80')
    .option('--source <value>', 'Filter by source, e.g. sdk|dashboard|cli')
    .option('--origin-name <value>', 'Filter by origin label')
    .option('--location-id <value>', 'Filter by location id')
    .action(
      async (options: {
        project?: string;
        last?: string;
        since?: string;
        until?: string;
        limit?: string;
        source?: string;
        originName?: string;
        locationId?: string;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const projectId = await resolveProjectId(options.project);
          const limit = Number.parseInt(String(options.limit ?? '80'), 10);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw Object.assign(new Error('Invalid --limit. Use an integer between 1 and 200.'), {
              exitCode: 2,
            });
          }

          const query = buildQueryString({
            limit,
            ...(options.since ? { since: options.since.trim() } : {}),
            ...(options.until ? { until: options.until.trim() } : {}),
            ...(!options.since && !options.until
              ? { last: normalizeDuration(options.last, '30d') }
              : {}),
            source: normalizeOptionalString(options.source),
            originName: normalizeOptionalString(options.originName),
            locationId: normalizeOptionalString(options.locationId),
          });

          const payload = (await requestApi(
            'GET',
            `/v1/projects/${projectId}/feedback/messages${query}`,
            undefined,
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          )) as FeedbackListResponse;

          const summary = buildFeedbackSummary(payload);

          if (root.format === 'text') {
            print('text', renderFeedbackSummaryText(summary));
            return;
          }

          print(root.format, summary);
        });
      },
    );
};
