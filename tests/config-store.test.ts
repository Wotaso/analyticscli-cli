import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const TEST_API_URL = 'https://api.default.example';
const configDir = await mkdtemp(join(tmpdir(), 'analyticscli-config-store-'));
process.env.ANALYTICSCLI_CONFIG_DIR = configDir;
process.env.ANALYTICSCLI_API_URL = TEST_API_URL;

const store = await import('../src/config-store.js');

const removeConfigFile = async (): Promise<void> => {
  await unlink(store.configPath).catch(() => {
    // Ignore missing file between tests.
  });
};

test('readConfig returns defaults when config file does not exist', async () => {
  await removeConfigFile();

  const config = await store.readConfig();
  assert.equal(config.apiUrl, undefined);
  assert.equal(store.resolveApiUrl(config), TEST_API_URL);
  assert.equal(config.skillAutoUpdate, false);
  assert.match(config.updatedAt, /T/);
});

test('readConfig normalizes types without legacy suppressed update fallback', async () => {
  await removeConfigFile();
  await mkdir(dirname(store.configPath), { recursive: true });
  await writeFile(
    store.configPath,
    JSON.stringify({
      apiUrl: 'https://api.custom.example',
      token: 'token-from-file',
      tokenStorage: 'config_file',
      selectedProjectId: 'project_123',
      setupAgents: ['openclaw', 'codex', 'openclaw', 'invalid'],
      skillAutoUpdate: true,
      lastSkillSyncAt: '2026-03-20T10:00:00.000Z',
      lastSeenCliVersion: '0.1.0',
      lastCliVersionCheckAt: '2026-03-20T11:00:00.000Z',
      lastCliVersionNotified: '0.1.1',
      setupCompletedAt: '2026-03-20T12:00:00.000Z',
      updatedAt: '2026-03-20T13:00:00.000Z',
    }),
    'utf8',
  );

  const config = await store.readConfig();
  assert.equal(config.apiUrl, 'https://api.custom.example');
  assert.equal(config.token, 'token-from-file');
  assert.equal(config.tokenStorage, 'config_file');
  assert.equal(config.selectedProjectId, 'project_123');
  assert.deepEqual(config.setupAgents, ['openclaw', 'codex']);
  assert.equal(config.skillAutoUpdate, true);
  assert.equal(config.lastSkillSyncAt, '2026-03-20T10:00:00.000Z');
  assert.equal(config.lastSeenCliVersion, '0.1.0');
  assert.equal(config.lastCliVersionCheckAt, '2026-03-20T11:00:00.000Z');
  assert.equal(config.lastCliVersionNotified, '0.1.1');
  assert.equal(config.suppressedCliUpdateVersion, undefined);
  assert.equal(config.setupCompletedAt, '2026-03-20T12:00:00.000Z');
  assert.equal(config.updatedAt, '2026-03-20T13:00:00.000Z');
});

test('readConfig falls back to defaults for invalid field types', async () => {
  await removeConfigFile();
  await mkdir(dirname(store.configPath), { recursive: true });
  await writeFile(
    store.configPath,
    JSON.stringify({
      apiUrl: 123,
      token: 456,
      tokenStorage: 'invalid',
      skillAutoUpdate: 'true',
      lastCliVersionNotified: '0.1.2',
      suppressedCliUpdateVersion: '0.1.3',
      updatedAt: 123,
    }),
    'utf8',
  );

  const config = await store.readConfig();
  assert.equal(config.apiUrl, undefined);
  assert.equal(store.resolveApiUrl(config), TEST_API_URL);
  assert.equal(config.token, undefined);
  assert.equal(config.tokenStorage, undefined);
  assert.equal(config.skillAutoUpdate, false);
  assert.equal(config.suppressedCliUpdateVersion, '0.1.3');
  assert.match(config.updatedAt, /T/);
});

test('readConfig ignores legacy local default api URL from old config files', async () => {
  await removeConfigFile();
  await mkdir(dirname(store.configPath), { recursive: true });
  await writeFile(
    store.configPath,
    JSON.stringify({
      apiUrl: 'http://localhost:4000',
      updatedAt: '2026-03-20T13:00:00.000Z',
    }),
    'utf8',
  );

  const config = await store.readConfig();
  assert.equal(config.apiUrl, undefined);
  assert.equal(store.resolveApiUrl(config), TEST_API_URL);
});

test('writeConfigValue and auth token helpers persist expected config shape', async () => {
  await removeConfigFile();

  const baseConfig = {
    apiUrl: TEST_API_URL,
    token: 'fallback-token',
    tokenStorage: 'config_file' as const,
    updatedAt: '2026-03-20T15:00:00.000Z',
  };

  await store.writeConfigValue(baseConfig);
  const persistedText = await readFile(store.configPath, 'utf8');
  assert.match(persistedText, /"tokenStorage": "config_file"/);

  assert.equal(store.resolveAuthToken(baseConfig, 'override-token'), 'override-token');
  assert.equal(store.resolveAuthToken(baseConfig), 'fallback-token');
  assert.equal(store.resolveApiUrl(baseConfig, 'https://api.override.example/'), 'https://api.override.example');
});
