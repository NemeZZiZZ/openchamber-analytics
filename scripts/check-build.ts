import { existsSync, readFileSync } from 'node:fs';

interface CheckProblem {
  path: string;
  problem: string;
}

const htmlEntries: { html: string; sourceEntry: string; outputJs: string; outputCss: string }[] = [
  { html: 'panel/index.html', sourceEntry: 'src/panel/main.ts', outputJs: 'panel/main.js', outputCss: 'panel/main.css' },
  { html: 'page/index.html', sourceEntry: 'src/page/main.ts', outputJs: 'page/main.js', outputCss: 'page/main.css' },
];

const problems: CheckProblem[] = [];

for (const entry of htmlEntries) {
  if (!existsSync(entry.html)) {
    problems.push({ path: entry.html, problem: 'missing HTML entry' });
    continue;
  }

  const html = readFileSync(entry.html, 'utf8');

  // Classic local script only; remote or module loading is not allowed in the sandboxed iframe.
  const scriptMatch = html.match(/<script[^>]*\ssrc=["']([^"']+)["']/);
  if (!scriptMatch || scriptMatch[1] !== './main.js') {
    problems.push({ path: entry.html, problem: `expected <script src="./main.js">, found ${scriptMatch?.[1] ?? 'none'}` });
  } else if (html.includes('type="module"')) {
    problems.push({ path: entry.html, problem: 'module scripts are not allowed in guest iframes' });
  }

  if (!html.includes('main.css')) {
    problems.push({ path: entry.html, problem: 'expected ./main.css stylesheet link' });
  }

  for (const source of html.matchAll(/(?:src|href)=["'](https?:)?\/\//g)) {
    if (source[1]) {
      problems.push({ path: entry.html, problem: 'remote scripts/styles are forbidden' });
    }
  }

  // Once the source entry exists, its committed bundle must exist too.
  if (existsSync(entry.sourceEntry) && !existsSync(entry.outputJs)) {
    problems.push({ path: entry.outputJs, problem: 'source entry exists but bundle is not built' });
  }
}

if (existsSync('src/service/main.ts') && !existsSync('service/main.js')) {
  problems.push({ path: 'service/main.js', problem: 'service source exists but bundle is not built' });
}

if (problems.length > 0) {
  for (const { path, problem } of problems) {
    console.error(`check:build ${path}: ${problem}`);
  }
  process.exit(1);
}

console.log('check:build OK');
