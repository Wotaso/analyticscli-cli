export const noProjectsFoundMessage = (): string =>
  [
    'No accessible projects were found for this token.',
    '',
    'What to do next:',
    '1) Create a project in your AnalyticsCLI dashboard: https://dash.analyticscli.com',
    '2) Run `analyticscli projects list` to confirm the project is visible for this token.',
    '3) Set a default project with `analyticscli projects select`.',
  ].join('\n');

export const noEventsFoundMessage = (input: {
  projectId?: string;
  last?: string;
}): string => {
  const projectSuffix = input.projectId ? ` --project ${input.projectId}` : '';
  const lastSuffix = input.last ? ` --last ${input.last}` : '';

  return [
    'No events were found for this project yet.',
    '',
    'What to do next:',
    '1) Integrate the AnalyticsCLI SDK in your codebase.',
    '2) Initialize the SDK with your project publishable API key (Dashboard -> API Keys).',
    '3) Trigger at least one event in your app (for example `onboarding:start`).',
    `4) Re-run: \`analyticscli schema events${projectSuffix}${lastSuffix}\`.`,
    '',
    'If this project is already instrumented, widen your time range or remove restrictive filters.',
  ].join('\n');
};
