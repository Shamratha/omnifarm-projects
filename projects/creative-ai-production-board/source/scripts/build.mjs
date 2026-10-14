import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryFiles = ['index.html', 'styles.css', 'app.js', 'board-data.js', 'validation.js'];
const requiredAssets = ['hands.svg', 'rooftop.svg', 'skyline.svg', 'window.svg'];
const referenceOrigin = 'http://static-build.invalid';
const isDocumentationOrTest = (name) => /(?:^|\/)(?:README|LICENSE|CHANGELOG)(?:\.|$)|\.(?:md|mdx|rst)$|(?:^|[./_-])(?:test|spec)(?:[./_-]|$)/i.test(name);

async function requireFile(root, name) {
  let info;
  try {
    info = await lstat(join(root, name));
  } catch (error) {
    throw new Error(`Required static file is missing: ${name}`, { cause: error });
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Static files must be regular files, not links: ${name}`);
  }
}

async function assetFiles(root, folder = 'assets') {
  const entries = await readdir(join(root, folder), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const name = `${folder}/${entry.name}`;
    if (isDocumentationOrTest(name) || entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Asset links cannot be deployed: ${name}`);
    if (entry.isDirectory()) files.push(...await assetFiles(root, name));
    else {
      await requireFile(root, name);
      files.push(name);
    }
  }
  return files;
}

function checkModuleSyntax(source, name) {
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: source,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Invalid ES module syntax in ${name}:\n${result.stderr || result.error?.message}`);
  }
}

function decodeEntities(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = entity[2].toLowerCase() === 'x';
    return String.fromCodePoint(Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10));
  });
}

function references(source, name) {
  const found = [];
  const add = (value, module = false) => found.push({ value: decodeEntities(value.trim()), module });
  const extension = extname(name);
  if (['.html', '.svg'].includes(extension)) {
    const markup = source.replace(/<!--[\s\S]*?-->/g, '');
    if (/<base\b/i.test(markup)) throw new Error(`${name}: <base> is unsupported by this root-relative static build`);
    for (const tag of markup.matchAll(/<[a-z][^>]*>/gi)) {
      for (const attribute of tag[0].matchAll(/\b(src|href|xlink:href|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        const value = attribute[2] ?? attribute[3] ?? attribute[4];
        if (attribute[1].toLowerCase() === 'srcset') {
          for (const candidate of value.split(',')) add(candidate.trim().split(/\s+/)[0]);
        } else add(value);
      }
    }
    for (const script of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      if (/\btype\s*=\s*["']module["']/i.test(script[1]) && !/\bsrc\s*=/i.test(script[1])) {
        checkModuleSyntax(script[2], `${name} inline module`);
        found.push(...references(script[2], 'inline.js'));
      }
    }
  }
  if (['.css', '.html', '.svg'].includes(extension)) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of css.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) add(match[1] ?? match[2] ?? match[3]);
    for (const match of css.matchAll(/@import\s+["']([^"']+)["']/gi)) add(match[1]);
  }
  if (['.js', '.mjs'].includes(extension)) {
    // Syntax is checked by Node first. Cover static imports, re-exports,
    // literal dynamic imports, and runtime references to bundled assets.
    for (const match of source.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/g)) add(match[1], true);
    for (const match of source.matchAll(/\bimport\s*(?:\(\s*)?["'`]([^"'`]+)["'`]/g)) {
      if (match[1].includes('${')) throw new Error(`${name}: module reference cannot be verified: ${match[1]}`);
      add(match[1], true);
    }
    for (const match of source.matchAll(/["'`]((?:\.\.?\/|\/)?assets\/[^"'`\s]+)["'`]/g)) {
      if (match[1].includes('${')) throw new Error(`${name}: asset reference cannot be verified: ${match[1]}`);
      add(match[1]);
    }
    for (const match of source.matchAll(/\b(?:fetch|Worker|URL)\s*\(\s*["']([^"']+)["']/g)) add(match[1]);
    for (const match of source.matchAll(/\b(?:image|src|href|poster|url)\s*:\s*["']([^"']+)["']/g)) add(match[1]);
  }
  return found;
}

function verifyReference({ value, module }, name, deployedFiles) {
  if (!value || value.startsWith('#') || /^(?:data|blob|mailto|tel):/i.test(value)) return;
  let url;
  try {
    url = new URL(value, `${referenceOrigin}/${name}`);
  } catch {
    throw new Error(`${name}: invalid static reference "${value}"`);
  }
  if (url.origin !== referenceOrigin) {
    if (/^https?:$/.test(url.protocol)) return;
    throw new Error(`${name}: unsupported static reference "${value}"`);
  }
  if (module && !/^(?:\.\.?\/|\/)/.test(value)) {
    throw new Error(`${name}: bare module import cannot run in this static build: "${value}"`);
  }
  let target;
  try {
    target = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  } catch {
    throw new Error(`${name}: invalid URL encoding in "${value}"`);
  }
  if (!deployedFiles.has(target)) {
    throw new Error(`${name}: missing local reference "${value}" (expected deployed file ${target})`);
  }
}

export async function build({ root = projectRoot, quiet = false } = {}) {
  const files = [...entryFiles];
  for (const name of entryFiles) await requireFile(root, name);
  for (const name of requiredAssets) await requireFile(root, `assets/${name}`);
  files.push(...await assetFiles(root));
  const deployedFiles = new Set(files);
  const contents = new Map();
  for (const name of files) {
    const bytes = await readFile(join(root, name));
    contents.set(name, bytes);
    if (!['.html', '.css', '.js', '.mjs', '.svg'].includes(extname(name))) continue;
    const source = bytes.toString('utf8');
    if (['.js', '.mjs'].includes(extname(name))) checkModuleSyntax(source, name);
    for (const reference of references(source, name)) verifyReference(reference, name, deployedFiles);
  }

  // Validate everything before replacing the previous successful deployment.
  const output = join(root, 'dist');
  const staging = join(root, 'scripts', '.dist-staging');
  await rm(staging, { recursive: true, force: true });
  try {
    for (const name of files) {
      const destination = join(staging, name);
      await mkdir(dirname(destination), { recursive: true });
      // Emit the exact bytes that were checked, even if a source editor saves
      // another version while this build is in progress.
      await writeFile(destination, contents.get(name));
    }
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (!quiet) console.log(`Build passed: ${files.length} static files validated and copied to ${relative(projectRoot, output) || 'dist'}/`);
  return { output, files };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  build().catch((error) => {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
