import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractApi, getDeclarationDiagnostics, type ApiDiagnostic, type ApiDocument, type ApiKind } from './extract';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(scriptDirectory, '..');
export const outputPath = path.join(projectRoot, 'public/generated/api.json');
export const manifestPath = path.join(projectRoot, 'public/generated/manifest.json');
export const diagnosticsPath = path.join(projectRoot, 'public/generated/diagnostics.json');
export const apiPublicPath = '/generated/api.json';
export const manifestPublicPath = '/generated/manifest.json';
export const diagnosticsPublicPath = '/generated/diagnostics.json';

export const sourceVersions = [
  { version: '5.99.0', label: 'Latest' as const, sourcePath: 'samples/v2/webpack.d.ts' },
  { version: '5.98.0', label: 'Previous' as const, sourcePath: 'samples/v1/webpack.d.ts' },
];

const symbolKinds: ApiKind[] = ['class', 'interface', 'function', 'namespace', 'type', 'variable'];

export interface ApiManifest {
  schemaVersion: 1;
  packageName: ApiDocument['packageName'];
  generatedFrom: {
    generatorPath: 'scripts/generate.ts';
    sources: Array<{
      version: string;
      label: 'Latest' | 'Previous';
      sourcePath: string;
    }>;
  };
  versions: Array<{
    version: string;
    label: 'Latest' | 'Previous';
    apiPath: string;
    sourcePath: string;
    symbolCount: number;
    memberCount: number;
    symbolCounts: Record<ApiKind, number>;
  }>;
  urls: {
    api: string;
    manifest: string;
    version: string;
    symbol: string;
    source: string;
    compare: string;
    diagnostics: string;
  };
  anchors: {
    symbol: string;
    member: string;
    overload: string;
    diff: string;
    sourceLine: string;
  };
}

export interface GeneratedFiles {
  api: string;
  manifest: string;
  diagnostics: string;
}

export function generateApiJson(): string {
  return formatJson(extractApi(sourceVersions, projectRoot));
}

export function generateManifestJson(): string {
  return formatJson(createManifest(extractApi(sourceVersions, projectRoot)));
}

export function generateFiles(): GeneratedFiles {
  const api = extractApi(sourceVersions, projectRoot);
  return {
    api: formatJson(api),
    manifest: formatJson(createManifest(api)),
    diagnostics: generateDiagnosticsJson(),
  };
}

export function generateDiagnosticsJson(): string {
  const versions = sourceVersions.map(source => ({
    version: source.version,
    label: source.label,
    sourcePath: source.sourcePath,
    diagnostics: getDeclarationDiagnostics(path.join(projectRoot, source.sourcePath), projectRoot),
  }));
  return formatJson({ schemaVersion: 1, packageName: 'webpack', versions, hasErrors: versions.some(version => version.diagnostics.some(item => item.category === 'error')) });
}

export function writeApiJson(destination = outputPath): void {
  writeFile(destination, generateApiJson());
}

export function writeManifestJson(destination = manifestPath): void {
  writeFile(destination, generateManifestJson());
}

export function writeGeneratedFiles(
  apiDestination = outputPath,
  manifestDestination = manifestPath,
  diagnosticsDestination = diagnosticsPath,
): void {
  const files = generateFiles();
  writeFile(apiDestination, files.api);
  writeFile(manifestDestination, files.manifest);
  writeFile(diagnosticsDestination, files.diagnostics);
}

export function checkApiJson(destination = outputPath): void {
  checkFile(destination, generateApiJson(), 'Generated API');
}

export function checkManifestJson(destination = manifestPath): void {
  checkFile(destination, generateManifestJson(), 'Generated manifest');
}

export function checkGeneratedFiles(
  apiDestination = outputPath,
  manifestDestination = manifestPath,
  diagnosticsDestination = diagnosticsPath,
): void {
  const files = generateFiles();
  checkFile(apiDestination, files.api, 'Generated API');
  checkFile(manifestDestination, files.manifest, 'Generated manifest');
  checkFile(diagnosticsDestination, files.diagnostics, 'Generated diagnostics');
}

function createManifest(api: ApiDocument): ApiManifest {
  return {
    schemaVersion: 1,
    packageName: api.packageName,
    generatedFrom: {
      generatorPath: 'scripts/generate.ts',
      sources: sourceVersions.map(source => ({ ...source })),
    },
    versions: api.versions.map(version => ({
      version: version.version,
      label: version.label,
      apiPath: apiPublicPath,
      sourcePath: version.sourcePath,
      symbolCount: version.symbols.length,
      memberCount: version.symbols.reduce((count, symbol) => count + symbol.members.length, 0),
      symbolCounts: symbolKinds.reduce<Record<ApiKind, number>>((counts, kind) => {
        counts[kind] = version.symbols.filter(symbol => symbol.kind === kind).length;
        return counts;
      }, {} as Record<ApiKind, number>),
    })),
    urls: {
      api: apiPublicPath,
      manifest: manifestPublicPath,
      version: '/?version={version}',
      symbol: '/?version={version}&symbol={symbolId}#symbol-{stableSymbolId}',
      source: '/?version={version}&source={sourcePath}#L{line}',
      compare: '/?version={version}&compare=true#compare',
      diagnostics: '/?diagnostics=true',
    },
    anchors: {
      symbol: 'symbol-{stableSymbolId}',
      member: 'member-{stableMemberId}',
      overload: 'overload-{stableOwnerId}-{index}',
      diff: 'diff-{stableSymbolId}',
      sourceLine: 'L{line}',
    },
  };
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFile(destination: string, content: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
}

function checkFile(destination: string, expected: string, description: string): void {
  let actual: string;
  try {
    actual = fs.readFileSync(destination, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`${description} is missing: ${path.relative(projectRoot, destination)}`);
    }
    throw error;
  }
  if (actual !== expected) {
    throw new Error(
      `${description} is stale: ${path.relative(projectRoot, destination)}\n` +
      'Run tsx scripts/generate.ts to refresh it.',
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

const invokedScript = process.argv[1] && path.basename(process.argv[1]).startsWith('generate.');
if (invokedScript) {
  if (process.argv.includes('--check')) {
    checkGeneratedFiles();
  } else {
    writeGeneratedFiles();
  }
}
