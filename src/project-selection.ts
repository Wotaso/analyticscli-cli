import { emitKeypressEvents } from 'node:readline';
import { readConfig, writeConfigValue } from './config-store.js';
import { noProjectsFoundMessage } from './dx-messages.js';
import { requestApi } from './http.js';
import type { ClientOptions } from './types.js';

export type ProjectOption = {
  id: string;
  label: string;
  name?: string;
  slug?: string;
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const extractProjectOptions = (payload: unknown): ProjectOption[] => {
  const candidates = (() => {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === 'object') {
      const objectPayload = payload as Record<string, unknown>;
      if (Array.isArray(objectPayload.projects)) {
        return objectPayload.projects;
      }
      if (Array.isArray(objectPayload.items)) {
        return objectPayload.items;
      }
      if (Array.isArray(objectPayload.data)) {
        return objectPayload.data;
      }
    }

    return [];
  })();

  const byId = new Map<string, ProjectOption>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const id =
      normalizeString(record.id) ??
      normalizeString(record.projectId) ??
      normalizeString(record.project_id);
    if (!id) {
      continue;
    }

    const name = normalizeString(record.name) ?? normalizeString(record.displayName);
    const slug = normalizeString(record.slug);
    const label = name
      ? slug
        ? `${name} (${slug})`
        : name
      : slug ?? id;

    byId.set(id, {
      id,
      label: `${label} [${id}]`,
      name,
      slug,
    });
  }

  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
};

const clearRenderedLines = (lineCount: number): void => {
  if (lineCount <= 0) {
    return;
  }

  for (let index = 0; index < lineCount; index += 1) {
    process.stdout.write('\u001B[2K\r');
    if (index < lineCount - 1) {
      process.stdout.write('\u001B[1A');
    }
  }
};

export const promptProjectSelection = async (
  projects: ProjectOption[],
  title: string,
): Promise<ProjectOption> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw Object.assign(new Error('Interactive project selection requires a TTY.'), {
      exitCode: 2,
    });
  }

  if (projects.length === 0) {
    throw Object.assign(new Error(noProjectsFoundMessage()), { exitCode: 2 });
  }

  const stdin = process.stdin;
  if (typeof stdin.setRawMode !== 'function') {
    throw Object.assign(new Error('Interactive arrow-key selection is not supported in this terminal.'), {
      exitCode: 2,
    });
  }

  const wasRawMode = Boolean(stdin.isRaw);
  let selectedIndex = 0;
  let renderedLineCount = 0;
  let finished = false;

  const render = () => {
    clearRenderedLines(renderedLineCount);
    const lines = [
      `${title}`,
      'Use ↑/↓ to choose, Enter to confirm, Ctrl+C to cancel.',
      ...projects.map((project, index) => `${index === selectedIndex ? '>' : ' '} ${project.label}`),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    renderedLineCount = lines.length;
  };

  const cleanup = () => {
    if (finished) {
      return;
    }

    finished = true;
    stdin.off('keypress', onKeypress);
    stdin.pause();
    stdin.setRawMode(wasRawMode);
    process.stdout.write('\u001B[?25h');
  };

  const onKeypress = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
    if (key.ctrl && key.name === 'c') {
      cleanup();
      clearRenderedLines(renderedLineCount);
      process.stdout.write('\n');
      rejectPromise(
        Object.assign(new Error('Project selection canceled.'), {
          exitCode: 2,
        }),
      );
      return;
    }

    if (key.name === 'up') {
      selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : projects.length - 1;
      render();
      return;
    }

    if (key.name === 'down') {
      selectedIndex = selectedIndex < projects.length - 1 ? selectedIndex + 1 : 0;
      render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter' || str === '\r') {
      const selected = projects[selectedIndex];
      if (!selected) {
        return;
      }
      cleanup();
      clearRenderedLines(renderedLineCount);
      process.stdout.write('\n');
      resolvePromise(selected);
    }
  };

  let resolvePromise!: (value: ProjectOption) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const selectionPromise = new Promise<ProjectOption>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  process.stdout.write('\u001B[?25l');
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('keypress', onKeypress);
  render();

  return selectionPromise.finally(() => {
    cleanup();
  });
};

export const fetchProjectOptions = async (options: ClientOptions): Promise<ProjectOption[]> => {
  const payload = await requestApi('GET', '/v1/projects', undefined, options);
  return extractProjectOptions(payload);
};

export const setSelectedProjectId = async (projectId: string): Promise<void> => {
  const normalizedProjectId = normalizeString(projectId);
  if (!normalizedProjectId) {
    throw Object.assign(new Error('Project ID is required.'), { exitCode: 2 });
  }

  const config = await readConfig();
  await writeConfigValue({
    ...config,
    selectedProjectId: normalizedProjectId,
    updatedAt: new Date().toISOString(),
  });
};

export const resolveProjectId = async (input: {
  explicitProjectId?: string;
  rootProjectId?: string;
  apiUrl?: string;
  token?: string;
  allowInteractiveSelection?: boolean;
}): Promise<{ projectId: string; source: 'explicit' | 'global' | 'config' | 'interactive' }> => {
  const explicitProjectId = normalizeString(input.explicitProjectId);
  if (explicitProjectId) {
    return { projectId: explicitProjectId, source: 'explicit' };
  }

  const rootProjectId = normalizeString(input.rootProjectId);
  if (rootProjectId) {
    return { projectId: rootProjectId, source: 'global' };
  }

  const config = await readConfig();
  const configProjectId = normalizeString(config.selectedProjectId);
  if (configProjectId) {
    return { projectId: configProjectId, source: 'config' };
  }

  const allowInteractive = input.allowInteractiveSelection !== false;
  if (!allowInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw Object.assign(
      new Error(
        'Project ID is missing. Pass --project <id> or choose one with `analyticscli projects select`.',
      ),
      { exitCode: 2 },
    );
  }

  const projects = await fetchProjectOptions({
    apiUrl: input.apiUrl,
    token: input.token,
  });
  if (projects.length === 0) {
    throw Object.assign(
      new Error(noProjectsFoundMessage()),
      { exitCode: 3 },
    );
  }

  const selected =
    projects.length === 1
      ? projects[0]!
      : await promptProjectSelection(projects, 'Select a default project for this command');

  await setSelectedProjectId(selected.id);
  return {
    projectId: selected.id,
    source: 'interactive',
  };
};
