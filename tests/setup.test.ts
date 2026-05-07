import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ANALYTICSCLI_CONFIG_DIR = process.env.ANALYTICSCLI_CONFIG_DIR || '/tmp/analyticscli-setup-test';
process.env.ANALYTICSCLI_API_URL = process.env.ANALYTICSCLI_API_URL || 'https://api.default.example';

const { parseSetupAgents, promptLoginMode, resolveAutoRefreshSkillNames } = await import('../src/setup.js');

test('parseSetupAgents keeps valid unique setup targets and expands all', () => {
  assert.deepEqual(parseSetupAgents('openclaw,codex,openclaw,claude'), ['openclaw', 'codex', 'claude']);
  assert.deepEqual(parseSetupAgents('all'), ['codex', 'claude', 'openclaw']);
});

test('resolveAutoRefreshSkillNames keeps ClawHub-only skills out of GitHub skill refresh', () => {
  assert.deepEqual(resolveAutoRefreshSkillNames(['codex']), ['analyticscli-cli']);
  assert.deepEqual(resolveAutoRefreshSkillNames(['openclaw']), ['analyticscli-cli']);
});

test('promptLoginMode explains query access and defaults to existing token when available', async () => {
  let askedQuestion = '';
  const output = await captureStdout(async () => {
    const result = await promptLoginMode(
      {
        question: async (question: string) => {
          askedQuestion = question;
          return '';
        },
      },
      true,
    );

    assert.equal(result, 'existing');
  });

  assert.match(output, /CLI query access/);
  assert.match(output, /readonly CLI token/);
  assert.match(output, /not the SDK publishable ingest key/);
  assert.match(output, /Keep using the token already stored on this machine/);
  assert.equal(askedQuestion, 'Choose query access [1-3] (default 2): ');
});

test('promptLoginMode defaults to a new readonly token when none is stored', async () => {
  let askedQuestion = '';
  const output = await captureStdout(async () => {
    const result = await promptLoginMode(
      {
        question: async (question: string) => {
          askedQuestion = question;
          return '';
        },
      },
      false,
    );

    assert.equal(result, 'provided');
  });

  assert.match(output, /Paste a new readonly CLI token/);
  assert.match(output, /Skip login for now \(skills only\)/);
  assert.equal(askedQuestion, 'Choose query access [1-2] (default 1): ');
});

const captureStdout = async (callback: () => Promise<void>): Promise<string> => {
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: (chunk: unknown, ...args: unknown[]) => boolean;
  };
  const originalWrite = stdout.write;
  let output = '';

  stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof stdout.write;

  try {
    await callback();
  } finally {
    stdout.write = originalWrite;
  }

  return output;
};
