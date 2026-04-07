import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ANALYTICSCLI_CONFIG_DIR = process.env.ANALYTICSCLI_CONFIG_DIR || '/tmp/analyticscli-setup-test';
process.env.ANALYTICSCLI_API_URL = process.env.ANALYTICSCLI_API_URL || 'https://api.default.example';

const { parseSetupAgents, resolveAutoRefreshSkillNames } = await import('../src/setup.js');

test('parseSetupAgents keeps valid unique setup targets and expands all', () => {
  assert.deepEqual(parseSetupAgents('openclaw,codex,openclaw,claude'), ['openclaw', 'codex', 'claude']);
  assert.deepEqual(parseSetupAgents('all'), ['codex', 'claude', 'openclaw']);
});

test('resolveAutoRefreshSkillNames keeps ClawHub-only skills out of GitHub skill refresh', () => {
  assert.deepEqual(resolveAutoRefreshSkillNames(['codex']), ['analyticscli-cli']);
  assert.deepEqual(resolveAutoRefreshSkillNames(['openclaw']), ['analyticscli-cli']);
});
