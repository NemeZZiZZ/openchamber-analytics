import { existsSync } from 'node:fs';
import { build } from 'esbuild';

type Target = {
  entry: string;
  outfile: string;
  format: 'iife' | 'esm';
  platform: 'browser' | 'node';
  target: string;
};

/**
 * Browser surfaces are sandboxed classic-script iframes: ship bundled IIFEs.
 * The service is bundled for the host Node runtime. Committed outputs are the
 * installable package; OpenChamber never runs a build step at install time.
 */
const targets: Target[] = [
  {
    entry: 'src/panel/main.ts',
    outfile: 'panel/main.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  },
  {
    entry: 'src/page/main.ts',
    outfile: 'page/main.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  },
  {
    entry: 'src/service/main.ts',
    outfile: 'service/main.js',
    format: 'esm',
    platform: 'node',
    target: 'node20',
  },
];

let built = 0;

for (const target of targets) {
  if (!existsSync(target.entry)) {
    console.warn(`build: skip ${target.entry} (entry not implemented yet)`);
    continue;
  }

  await build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    minify: true,
    sourcemap: false,
    format: target.format,
    platform: target.platform,
    target: [target.target],
    logLevel: 'info',
    legalComments: 'none',
  });
  built += 1;
}

console.log(`build: ${built} target(s) bundled`);
