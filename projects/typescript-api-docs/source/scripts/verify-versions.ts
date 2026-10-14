import { extractVersion } from './extract';
import { projectRoot, sourceVersions } from './generate';

for (const source of sourceVersions) {
  const version = extractVersion(source, projectRoot);
  if (!version.sourceText.trim() || version.symbols.length === 0) {
    throw new Error(`Version ${source.version} produced no declaration content or symbols.`);
  }
  const named = version.symbols.filter(symbol => symbol.signatures.length > 0);
  if (named.length === 0) throw new Error(`Version ${source.version} produced no signatures.`);
  console.log(`${source.label} ${source.version}: ${version.symbols.length} symbols, ${version.sourceText.split('\n').length} source lines`);
}
