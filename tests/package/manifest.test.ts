import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

type Manifest = {
  name: string;
  private?: boolean;
  openchamber: {
    apiVersion: number;
    engines: { openchamber: string };
    id: string;
    name: string;
    icon?: string;
    contributes: {
      panel: { entry: string; mobile?: boolean };
      page: { entry: string; title?: string; mobile?: boolean };
      capabilities: string[];
      service: {
        entry: string;
        runtime: string;
        provides: string[];
        keepRunning: boolean;
      };
    };
  };
};

function readManifest(): Manifest {
  return JSON.parse(readFileSync(`${packageRoot}/package.json`, 'utf8')) as Manifest;
}

describe('extension manifest', () => {
  const manifest = readManifest();
  const openchamber = manifest.openchamber;

  it('declares the analytics extension identity', () => {
    expect(manifest.name).toBe('openchamber-analytics');
    expect(openchamber.id).toBe('analytics');
    expect(openchamber.name).toBe('Analytics');
    expect(openchamber.apiVersion).toBe(1);
  });

  it('requires OpenChamber >=2.7.0', () => {
    expect(openchamber.engines.openchamber).toBe('>=2.7.0');
  });

  it('contributes a panel and a page entry', () => {
    expect(openchamber.contributes.panel.entry).toBe('panel/index.html');
    expect(openchamber.contributes.page.entry).toBe('page/index.html');
  });

  it('requests only the sessions capability', () => {
    expect(openchamber.contributes.capabilities).toEqual(['sessions']);
    expect(openchamber.contributes.capabilities).not.toContain('opencode');
  });

  it('declares a persistent host service that provides OpenCode', () => {
    const service = openchamber.contributes.service;
    expect(service.entry).toBe('service/main.js');
    expect(service.runtime).toBe('host');
    expect(service.provides).toEqual(['opencode']);
    expect(service.keepRunning).toBe(true);
  });
});
