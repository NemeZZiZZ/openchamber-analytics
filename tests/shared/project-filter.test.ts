import { describe, expect, it } from 'vitest';

import {
  PROJECT_SEPARATOR,
  projectFilterPatch,
  projectSelectOptions,
  projectSelectValue,
} from '../../src/shared/project-filter';
import type { ProjectEntry } from '../../src/shared/analytics-types';

const PROJECTS: ProjectEntry[] = [
  { directory: '/repo/demo', label: 'demo', sessions: 5, tokens: 12_300, cost: 1.5 },
  { directory: '/repo/tools', label: 'tools', sessions: 2, tokens: 4_100, cost: 0.4 },
];

describe('projectSelectOptions', () => {
  it('lists All, This project, a separator, then every project with a hint', () => {
    expect(projectSelectOptions({ hasDirectory: true, projects: PROJECTS })).toEqual([
      { value: 'all', label: 'All projects' },
      { value: 'this', label: 'This project' },
      { value: PROJECT_SEPARATOR, label: '────────────', disabled: true },
      { value: '/repo/demo', label: 'demo', hint: '12.3K tok · 5 sessions' },
      { value: '/repo/tools', label: 'tools', hint: '4.1K tok · 2 sessions' },
    ]);
  });

  it('hides This project without a host directory and drops the empty separator', () => {
    expect(projectSelectOptions({ hasDirectory: false, projects: [] })).toEqual([
      { value: 'all', label: 'All projects' },
    ]);
  });

  it('adds an ad-hoc entry for a pinned project missing from the list', () => {
    const options = projectSelectOptions({ hasDirectory: true, projects: PROJECTS, pinned: '/repo/ghost' });

    expect(options.at(-1)).toEqual({ value: '/repo/ghost', label: 'ghost', hint: '0 tok · 0 sessions' });
    expect(options.filter((option) => option.value === '/repo/ghost')).toHaveLength(1);
  });
});

describe('projectSelectValue', () => {
  it('maps scope and directory to the matching option value', () => {
    expect(projectSelectValue('all', undefined)).toBe('all');
    expect(projectSelectValue('project', undefined)).toBe('this');
    expect(projectSelectValue('project', '/repo/demo')).toBe('/repo/demo');
  });
});

describe('projectFilterPatch', () => {
  it('maps All projects to the all scope', () => {
    expect(projectFilterPatch('all')).toEqual({ scope: 'all' });
  });

  it('maps This project to a follow-mode project scope', () => {
    expect(projectFilterPatch('this')).toEqual({ scope: 'project' });
  });

  it('maps a project entry to a pinned project scope', () => {
    expect(projectFilterPatch('/repo/tools')).toEqual({ scope: 'project', directory: '/repo/tools' });
  });

  it('ignores the separator entry', () => {
    expect(projectFilterPatch(PROJECT_SEPARATOR)).toBeNull();
  });
});
