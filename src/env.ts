import { z } from 'zod';

const optionalUrlEnv = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}, z.string().url().optional());

const cliSchema = z.object({
  ANALYTICSCLI_API_URL: z.string().url().default('https://api.analyticscli.com'),
  ANALYTICSCLI_CONFIG_DIR: z.string().optional(),
  ANALYTICSCLI_ACCESS_TOKEN: z.string().min(1).optional(),
  ANALYTICSCLI_READONLY_TOKEN: z.string().min(1).optional(),
  ANALYTICSCLI_CLI_ENABLE_WRITE_COMMANDS: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  ANALYTICSCLI_CLI_ENABLE_DEV_COMMANDS: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  ANALYTICSCLI_SELF_TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  ANALYTICSCLI_SELF_TRACKING_ENDPOINT: optionalUrlEnv,
  ANALYTICSCLI_SELF_TRACKING_PROJECT_ID: z.string().uuid().optional(),
  ANALYTICSCLI_SELF_TRACKING_API_KEY: z.string().min(8).optional(),
  ANALYTICSCLI_SELF_TRACKING_PLATFORM: z.string().default('cli'),
  ANALYTICSCLI_FEEDBACK_SERVICE_URL: optionalUrlEnv,
  ANALYTICSCLI_FEEDBACK_SERVICE_API_KEY: z.string().min(8).optional(),
  ANALYTICSCLI_FEEDBACK_SERVICE_APP_ID: z.string().min(2).max(64).optional(),
  ANALYTICSCLI_FEEDBACK_USER_ID: z.string().min(1).max(128).optional(),
});

export type CliEnv = z.infer<typeof cliSchema>;

export const readCliEnv = (input: NodeJS.ProcessEnv = process.env): CliEnv => cliSchema.parse(input);
