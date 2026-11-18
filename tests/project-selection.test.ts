import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.ANALYTICSCLI_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'analyticscli-discovery-'));
const { fetchProjectOptions } = await import('../src/project-selection.js');

test('project discovery fetches newly created projects using the same account token', async () => {
  const originalFetch = globalThis.fetch;
  const projects = [{ id: 'project-1', name: 'Existing app', slug: 'existing' }];
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(String(input), 'https://api.example.com/v1/projects');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer same-account-token');
    return new Response(JSON.stringify({ items: projects, count: projects.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const options = { apiUrl: 'https://api.example.com', token: 'same-account-token' };
    assert.deepEqual((await fetchProjectOptions(options)).map((project) => project.id), ['project-1']);

    projects.push({ id: 'project-2', name: 'Smokezo', slug: 'smokezo' });
    const refreshed = await fetchProjectOptions(options);
    assert.deepEqual(refreshed.map((project) => project.id), ['project-1', 'project-2']);
    assert.equal(refreshed[1]?.name, 'Smokezo');
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
