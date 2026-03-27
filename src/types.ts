export type CliConfig = {
  apiUrl: string;
  token?: string;
  tokenStorage?: 'config_file' | 'system_keychain';
  selectedProjectId?: string;
  skillAutoUpdate?: boolean;
  lastSkillSyncAt?: string;
  lastSeenCliVersion?: string;
  lastCliVersionCheckAt?: string;
  lastCliVersionNotified?: string;
  suppressedCliUpdateVersion?: string;
  setupCompletedAt?: string;
  updatedAt: string;
};

export type OutputFormat = 'json' | 'text';

export type ClientOptions = {
  apiUrl?: string;
  token?: string;
};

export type CollectClientOptions = {
  endpoint: string;
  apiKey: string;
};

export type SetupAgent = 'codex' | 'claude' | 'openclaw';
export type SkillInstallTarget = 'codex_claude' | 'openclaw';

export type SkillInstallResult = {
  target: SkillInstallTarget;
  ok: boolean;
  skipped: boolean;
  detail: string;
};

export type SetupLoginResult = {
  ok: boolean;
  skipped?: boolean;
  mode?: 'provided_token' | 'existing_token';
  tokenStorage?: 'config_file' | 'system_keychain';
};

export type SetupExecutionOptions = {
  readonlyToken?: string;
  skipLogin?: boolean;
  skipSkills?: boolean;
  agents: SetupAgent[];
  autoSkillUpdate?: boolean;
};

export type SetupExecutionResult = {
  ok: true;
  apiUrl: string;
  configPath: string;
  login: SetupLoginResult;
  skillSetup: SkillInstallResult[];
  autoSkillUpdate: boolean;
  setupCompletedAt?: string;
};

export type PromptClient = {
  question: (query: string) => Promise<string>;
};

export type CommandRunResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type FlowSelectorPayload = {
  appVersion?: string;
  onboardingFlowId?: string;
  onboardingFlowVersion?: string;
  experimentVariant?: string;
  paywallId?: string;
  source?: string;
  projectSurface?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrer?: string;
  landingPath?: string;
};
