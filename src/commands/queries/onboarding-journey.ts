import type { Command } from 'commander';
import {
  asTimeseriesPoints,
  computeRateTrendFromTimeseriesPoints,
  computeTrendFromTimeseriesPoints,
  formatTrendSummary,
  isOnboardingScreenEvent,
  isPaywallJourneyEvent,
  mergeFlowSelector,
  print,
  resolveFlowSelectorOption,
  resolveProjectOption,
  resolveTrendInterval,
  toPercent,
} from '../../analytics-utils.js';
import {
  ONBOARDING_CORE_EVENTS,
  ONBOARDING_START_EVENT,
  ONBOARDING_PAYWALL_SOURCE,
  PAYWALL_ANCHOR_EVENTS,
  PAYWALL_JOURNEY_EVENT_ORDER,
  PAYWALL_SKIP_EVENTS,
  PURCHASE_SUCCESS_EVENTS,
} from '../../constants.js';
import { requestApi } from '../../http.js';
import { renderTable } from '../../render.js';
import type { TimeseriesPoint } from '../../render.js';
import type { FlowSelectorPayload } from '../../types.js';
import type { CliCommandContext } from '../context.js';

type OnboardingJourneyOptions = {
  project?: string;
  within: string;
  last: string;
  eventsLimit: string;
  withTrends?: boolean;
  appVersion?: string;
  flowId?: string;
  flowVersion?: string;
  variant?: string;
  paywallId?: string;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await mapper(item, index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
};

const formatFlowSummary = (flowSelection: FlowSelectorPayload | undefined): string => {
  if (!flowSelection) {
    return 'all';
  }

  return [
    flowSelection.appVersion ? `appVersion=${flowSelection.appVersion}` : null,
    flowSelection.onboardingFlowId ? `flowId=${flowSelection.onboardingFlowId}` : null,
    flowSelection.onboardingFlowVersion ? `flowVersion=${flowSelection.onboardingFlowVersion}` : null,
    flowSelection.experimentVariant ? `variant=${flowSelection.experimentVariant}` : null,
    flowSelection.paywallId ? `paywallId=${flowSelection.paywallId}` : null,
    flowSelection.source ? `source=${flowSelection.source}` : null,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(', ');
};

export const registerOnboardingJourneyCommand = (
  getCommand: Command,
  context: CliCommandContext,
): void => {
  const { withErrorHandling, getRootOptions, includeDebugFlag, resolveProjectId } = context;

  getCommand
    .command('onboarding-journey')
    .description('Get onboarding -> paywall -> purchase journey metrics for new users')
    .option('--project <id>', 'Project ID (optional when a default project is selected)')
    .option('--within <scope>', 'session|user', 'user')
    .option('--last <duration>', 'Time range like 30d', '30d')
    .option('--events-limit <n>', 'Schema events scan limit', '500')
    .option('--with-trends', 'Include first-vs-latest trend block for top funnel KPIs', false)
    .option('--app-version <version>', 'Filter by appVersion')
    .option('--flow-id <id>', 'Filter by onboardingFlowId')
    .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
    .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
    .option('--paywall-id <id>', 'Filter by paywallId')
    .action(async (options: OnboardingJourneyOptions) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const projectId = await resolveProjectId(options.project);
        const flowSelection = resolveFlowSelectorOption(options).flow;
        const includeTrends = Boolean(options.withTrends);
        const trendInterval = resolveTrendInterval(String(options.last));
        const paywallFlowSelection = mergeFlowSelector(flowSelection, {
          source: ONBOARDING_PAYWALL_SOURCE,
        });

        const queryConversion = async (from: string, to: string) => {
          return (await requestApi(
            'POST',
            '/v1/query/conversion_after',
            {
              ...resolveProjectOption(projectId),
              from,
              to,
              within: options.within,
              last: options.last,
              includeDebug: includeDebugFlag(),
              ...(flowSelection ? { flow: flowSelection } : {}),
              ...(isPaywallJourneyEvent(from) && paywallFlowSelection
                ? { fromFlow: paywallFlowSelection }
                : {}),
              ...(isPaywallJourneyEvent(to) && paywallFlowSelection
                ? { toFlow: paywallFlowSelection }
                : {}),
            },
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          )) as {
            totalFrom: number;
            totalConverted: number;
            conversionRate: number;
          };
        };

        const queryBestConversion = async (
          from: string,
          candidates: readonly string[],
        ): Promise<{
          eventName: string;
          count: number;
          totalFrom: number;
        }> => {
          const uniqueCandidates = [...new Set(candidates.filter((value) => value.trim().length > 0))];
          if (uniqueCandidates.length === 0) {
            return {
              eventName: '',
              count: 0,
              totalFrom: 0,
            };
          }

          const rows = await Promise.all(
            uniqueCandidates.map(async (eventName) => {
              const result = await queryConversion(from, eventName);
              return {
                eventName,
                count: result.totalConverted,
                totalFrom: result.totalFrom,
              };
            }),
          );

          return rows.reduce((best, current) => (current.count > best.count ? current : best));
        };

        const trendTimeseriesCache = new Map<string, Promise<TimeseriesPoint[]>>();
        const queryUniqueUserSeries = (eventName: string) => {
          const existing = trendTimeseriesCache.get(eventName);
          if (existing) {
            return existing;
          }

          const pending = requestApi(
            'POST',
            '/v1/query/timeseries',
            {
              ...resolveProjectOption(projectId),
              metric: 'unique_users',
              event: eventName,
              interval: trendInterval,
              last: options.last,
              includeDebug: includeDebugFlag(),
              ...(isPaywallJourneyEvent(eventName)
                ? paywallFlowSelection
                  ? { flow: paywallFlowSelection }
                  : {}
                : flowSelection
                  ? { flow: flowSelection }
                  : {}),
            },
            {
              apiUrl: root.apiUrl,
              token: root.accessToken,
            },
          ).then((payload) => asTimeseriesPoints(payload));

          trendTimeseriesCache.set(eventName, pending);
          return pending;
        };

        const schemaQuery = new URLSearchParams({
          projectId,
          limit: String(Number(options.eventsLimit)),
          includeDebug: String(includeDebugFlag()),
        });
        const schemaPayload = (await requestApi(
          'GET',
          `/v1/schema/events?${schemaQuery.toString()}`,
          undefined,
          {
            apiUrl: root.apiUrl,
            token: root.accessToken,
          },
        )) as {
          items?: Array<{ eventName?: string }>;
        };

        const completionFromStart = await queryConversion(ONBOARDING_START_EVENT, 'onboarding:complete');
        const stepCoveragePayload = (await requestApi(
          'POST',
          '/v1/query/onboarding_step_coverage',
          {
            ...resolveProjectOption(projectId),
            last: options.last,
            within: options.within,
            includeDebug: includeDebugFlag(),
            ...(flowSelection ? { flow: flowSelection } : {}),
          },
          {
            apiUrl: root.apiUrl,
            token: root.accessToken,
          },
        ).catch(() => null)) as
          | {
              rows?: Array<{
                eventName?: string;
                stepKey?: string;
                stepIndex?: number | null;
                users?: number;
              }>;
            }
          | null;
        const stepCoverageRows = (stepCoveragePayload?.rows ?? [])
          .map((row) => ({
            eventName: row.eventName || (row.stepKey ? `onboarding:step_view:${row.stepKey}` : ''),
            label: row.stepKey || row.eventName || '',
            stepIndex: row.stepIndex ?? null,
            users: Number(row.users ?? 0),
            percentFromStart: toPercent(Number(row.users ?? 0), completionFromStart.totalFrom),
          }))
          .filter((row) => row.eventName && row.users > 0);

        const discoveredEventNames = (schemaPayload.items ?? [])
          .map((item) => (typeof item.eventName === 'string' ? item.eventName : ''))
          .filter(Boolean);

        const discoveredOnboardingScreens = discoveredEventNames
          .filter((eventName) => isOnboardingScreenEvent(eventName))
          .slice(0, 12);

        const discoveredJourneyEvents = discoveredEventNames.filter(
          (eventName) =>
            eventName.startsWith('paywall:') ||
            eventName.startsWith('purchase:'),
        );

        const eventCandidates = [...new Set([
          ...ONBOARDING_CORE_EVENTS,
          ...(stepCoverageRows.length > 0 ? [] : discoveredOnboardingScreens),
          ...PAYWALL_JOURNEY_EVENT_ORDER,
          ...PAYWALL_SKIP_EVENTS,
          ...PURCHASE_SUCCESS_EVENTS,
          ...discoveredJourneyEvents,
        ])].filter(
          (eventName) =>
            eventName !== ONBOARDING_START_EVENT &&
            (stepCoverageRows.length === 0 ||
              (eventName !== 'onboarding:step_view' &&
                eventName !== 'onboarding:step_complete' &&
                !isOnboardingScreenEvent(eventName))),
        );

        const eventConversions = await mapWithConcurrency(
          eventCandidates,
          3,
          async (eventName) => {
            const result = await queryConversion(ONBOARDING_START_EVENT, eventName);
            return {
              eventName,
              users: result.totalConverted,
            };
          },
        );

        const [paywallAnchorByStart, bestSkipFromStart, bestPurchaseFromStart] = await Promise.all([
          queryBestConversion(ONBOARDING_START_EVENT, PAYWALL_ANCHOR_EVENTS),
          queryBestConversion(ONBOARDING_START_EVENT, PAYWALL_SKIP_EVENTS),
          queryBestConversion(ONBOARDING_START_EVENT, PURCHASE_SUCCESS_EVENTS),
        ]);

        const [bestSkipFromPaywall, bestPurchaseFromPaywall] = await Promise.all([
          queryBestConversion(paywallAnchorByStart.eventName, PAYWALL_SKIP_EVENTS),
          queryBestConversion(paywallAnchorByStart.eventName, PURCHASE_SUCCESS_EVENTS),
        ]);

        const starters = completionFromStart.totalFrom;
        const paywallExposedUsers =
          bestSkipFromPaywall.totalFrom ||
          bestPurchaseFromPaywall.totalFrom ||
          paywallAnchorByStart.totalFrom ||
          paywallAnchorByStart.count;

        let trends: {
          starters: ReturnType<typeof computeTrendFromTimeseriesPoints>;
          completionRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
          dropOffRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
          paywallReachedRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
          purchaseRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
        } | null = null;

        if (includeTrends) {
          const [
            startersSeries,
            completionSeries,
            selectedPaywallSeries,
            selectedPurchaseSeries,
          ] = await Promise.all([
            queryUniqueUserSeries(ONBOARDING_START_EVENT),
            queryUniqueUserSeries('onboarding:complete'),
            queryUniqueUserSeries(paywallAnchorByStart.eventName),
            queryUniqueUserSeries(bestPurchaseFromStart.eventName),
          ]);

          const completionByTs = new Map(completionSeries.map((point) => [point.ts, point.value] as const));
          const dropOffSeries = startersSeries.map((point) => ({
            ts: point.ts,
            value: Math.max(0, point.value - (completionByTs.get(point.ts) ?? 0)),
          }));

          trends = {
            starters: computeTrendFromTimeseriesPoints(startersSeries),
            completionRate: computeRateTrendFromTimeseriesPoints(completionSeries, startersSeries, 100),
            dropOffRate: computeRateTrendFromTimeseriesPoints(dropOffSeries, startersSeries, 100),
            paywallReachedRate: computeRateTrendFromTimeseriesPoints(selectedPaywallSeries, startersSeries, 100),
            purchaseRate: computeRateTrendFromTimeseriesPoints(selectedPurchaseSeries, startersSeries, 100),
          };
        }

        const eventOrder = new Map<string, number>(
          [...ONBOARDING_CORE_EVENTS, ...PAYWALL_JOURNEY_EVENT_ORDER].map((eventName, index) => [
            eventName,
            index,
          ]),
        );

        const coverageRows = [
          ...stepCoverageRows,
          ...eventConversions
          .map((row) => ({
            eventName: row.eventName,
            users: row.users,
            percentFromStart: toPercent(row.users, starters),
          }))
          .filter((row) => row.users > 0 || eventOrder.has(row.eventName)),
        ]
          .sort((a, b) => {
            const aStepIndex = 'stepIndex' in a ? a.stepIndex : null;
            const bStepIndex = 'stepIndex' in b ? b.stepIndex : null;
            if (typeof aStepIndex === 'number' && typeof bStepIndex === 'number') {
              return aStepIndex - bStepIndex;
            }
            if (typeof aStepIndex === 'number') return -1;
            if (typeof bStepIndex === 'number') return 1;
            const aIdx = eventOrder.get(a.eventName) ?? -1;
            const bIdx = eventOrder.get(b.eventName) ?? -1;
            const aIsOrdered = aIdx >= 0;
            const bIsOrdered = bIdx >= 0;
            if (aIsOrdered && bIsOrdered) return aIdx - bIdx;
            if (aIsOrdered) return -1;
            if (bIsOrdered) return 1;
            return b.users - a.users;
          });

        const payload = {
          projectId,
          within: options.within,
          last: options.last,
          startEvent: ONBOARDING_START_EVENT,
          flow: flowSelection ?? null,
          matchedRecords: starters,
          starters,
          completedUsers: completionFromStart.totalConverted,
          completionRate: toPercent(completionFromStart.totalConverted, starters),
          paywallAnchorEvent: paywallAnchorByStart.eventName,
          paywallReachedUsers: paywallAnchorByStart.count,
          paywallReachedRate: toPercent(paywallAnchorByStart.count, starters),
          paywallSkippedUsers: bestSkipFromStart.count,
          paywallSkipEvent: bestSkipFromStart.eventName,
          paywallSkipRateFromStart: toPercent(bestSkipFromStart.count, starters),
          paywallSkipRateFromPaywall: toPercent(bestSkipFromPaywall.count, paywallExposedUsers),
          purchasedUsers: bestPurchaseFromStart.count,
          purchaseEvent: bestPurchaseFromStart.eventName,
          purchaseRateFromStart: toPercent(bestPurchaseFromStart.count, starters),
          purchaseRateFromPaywall: toPercent(bestPurchaseFromPaywall.count, paywallExposedUsers),
          coverageRows,
          ...(includeTrends ? { trends } : {}),
        };

        if (root.format === 'text') {
          const summaryLines = [
            `Onboarding journey (${options.last}, within=${options.within})`,
            `flow: ${formatFlowSummary(flowSelection)}`,
            `paywall source: ${ONBOARDING_PAYWALL_SOURCE}`,
            `matched records: ${payload.matchedRecords}`,
            `starters: ${payload.starters}`,
            `completion: ${payload.completedUsers}/${payload.starters} (${payload.completionRate}%)`,
            `paywall reached: ${payload.paywallReachedUsers}/${payload.starters} (${payload.paywallReachedRate}%) via ${payload.paywallAnchorEvent}`,
            `skipped: ${payload.paywallSkippedUsers}/${payload.starters} (${payload.paywallSkipRateFromStart}%)`,
            `purchased: ${payload.purchasedUsers}/${payload.starters} (${payload.purchaseRateFromStart}%)`,
          ];
          if (payload.trends) {
            summaryLines.push(
              `trend new users: ${formatTrendSummary(payload.trends.starters)}`,
              `trend onboarding complete rate: ${formatTrendSummary(payload.trends.completionRate)}`,
              `trend drop-off rate: ${formatTrendSummary(payload.trends.dropOffRate)}`,
              `trend paywall reached rate: ${formatTrendSummary(payload.trends.paywallReachedRate)}`,
              `trend purchase rate: ${formatTrendSummary(payload.trends.purchaseRate)}`,
            );
          }
          const table = renderTable(
            ['event', 'users', '%start'],
            payload.coverageRows.map((row) => [
              'label' in row && typeof row.label === 'string' && row.label ? row.label : row.eventName,
              row.users,
              `${row.percentFromStart}%`,
            ]),
          );
          print('text', `${summaryLines.join('\n')}\n\n${table}`);
          return;
        }

        print(root.format, payload);
      });
    });
};
