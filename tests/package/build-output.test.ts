import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

let panelJs = '';
let pageJs = '';
let serviceJs = '';
let panelHtml = '';
let pageHtml = '';
let manifest: {
  openchamber: {
    contributes: {
      panel: { entry: string };
      page: { entry: string };
      service: { entry: string };
    };
  };
};

beforeAll(() => {
  execSync('npm run build', { cwd: packageRoot, stdio: 'pipe' });

  panelJs = readFileSync(resolve(packageRoot, 'panel/main.js'), 'utf8');
  pageJs = readFileSync(resolve(packageRoot, 'page/main.js'), 'utf8');
  serviceJs = readFileSync(resolve(packageRoot, 'service/main.js'), 'utf8');
  panelHtml = readFileSync(resolve(packageRoot, 'panel/index.html'), 'utf8');
  pageHtml = readFileSync(resolve(packageRoot, 'page/index.html'), 'utf8');
  manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
});

describe('installable package output', () => {
  it('builds every manifest entry into committed output files', () => {
    const contributes = manifest.openchamber.contributes;

    expect(existsSync(resolve(packageRoot, contributes.panel.entry))).toBe(true);
    expect(existsSync(resolve(packageRoot, contributes.page.entry))).toBe(true);
    expect(existsSync(resolve(packageRoot, contributes.service.entry))).toBe(true);
    expect(existsSync(resolve(packageRoot, 'panel/main.css'))).toBe(true);
    expect(existsSync(resolve(packageRoot, 'page/main.css'))).toBe(true);
  });

  it('keeps classic local script tags in both HTML entries', () => {
    for (const html of [panelHtml, pageHtml]) {
      expect(html).toMatch(/<script src="\.\/main\.js"><\/script>/);
      expect(html).not.toContain('type="module"');
      expect(html).not.toMatch(/(src|href)=["']https?:\/\//);
    }
  });

  it('never ships the OpenCode client, secrets, or Node APIs in browser bundles', () => {
    for (const [name, bundle] of [['panel/main.js', panelJs], ['page/main.js', pageJs]] as const) {
      expect(bundle.includes('@opencode/client'), name).toBe(false);
      expect(bundle.includes('OPENCHAMBER_OPENCODE_URL'), name).toBe(false);
      expect(bundle.includes('OPENCHAMBER_SERVICE_TOKEN'), name).toBe(false);
      expect(bundle.includes('require("node:'), name).toBe(false);
    }
  });

  it('keeps the service bundle free of browser entry code', () => {
    expect(serviceJs.includes('OPENCHAMBER_SERVICE_TOKEN')).toBe(true);
    expect(serviceJs.includes('OPENCHAMBER_OPENCODE_URL')).toBe(true);
    expect(serviceJs.includes('applyHostReady')).toBe(false);
    expect(serviceJs.includes('createElementNS')).toBe(false);
  });

  it('produces reproducible bundles across rebuilds', () => {
    const before = {
      panel: panelJs.length,
      page: pageJs.length,
      service: serviceJs.length,
    };

    execSync('npm run build', { cwd: packageRoot, stdio: 'pipe' });

    expect(readFileSync(resolve(packageRoot, 'panel/main.js'), 'utf8').length).toBe(before.panel);
    expect(readFileSync(resolve(packageRoot, 'page/main.js'), 'utf8').length).toBe(before.page);
    expect(readFileSync(resolve(packageRoot, 'service/main.js'), 'utf8').length).toBe(before.service);
  });
});
