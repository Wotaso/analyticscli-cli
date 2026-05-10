import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const configDir = await mkdtemp(join(tmpdir(), 'analyticscli-config-store-env-token-'));
process.env.ANALYTICSCLI_CONFIG_DIR = configDir;
process.env.ANALYTICSCLI_API_URL = 'https://api.default.example';
process.env.ANALYTICSCLI_ACCESS_TOKEN = 'token-from-env';

const store = await import('../src/config-store.js');

test('environment token overrides an older persisted token', async () => {
  await mkdir(dirname(store.configPath), { recursive: true });
  await writeFile(
    store.configPath,
    JSON.stringify({
      token: 'old-revoked-token-from-file',
      tokenStorage: 'config_file',
      updatedAt: '2026-05-10T13:00:00.000Z',
    }),
    'utf8',
  );

  const config = await store.readConfig();
  assert.equal(config.token, 'old-revoked-token-from-file');
  assert.equal(store.resolveAuthToken(config), 'token-from-env');
  assert.equal(store.resolveAuthToken(config, 'token-from-flag'), 'token-from-flag');
});
