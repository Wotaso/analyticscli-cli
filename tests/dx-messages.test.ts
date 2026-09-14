import assert from 'node:assert/strict';
import test from 'node:test';
import {
  noEventsFoundMessage,
  noQueryResultsMessage,
} from '../src/dx-messages.js';

test('distinguishes a new project from a filtered query with no matches', () => {
  const emptyProject = noEventsFoundMessage({
    projectId: 'project-1',
    last: '7d',
  });
  const emptyQuery = noQueryResultsMessage({
    projectId: 'project-1',
    last: '7d',
  });

  assert.match(emptyProject, /No events were found for this project yet\./);
  assert.match(emptyProject, /Integrate the AnalyticsCLI SDK/);

  assert.match(emptyQuery, /No events matched this query\./);
  assert.match(emptyQuery, /remove one or more filters/);
  assert.match(emptyQuery, /--project project-1 --last 7d/);
  assert.doesNotMatch(emptyQuery, /Integrate the AnalyticsCLI SDK/);
});
