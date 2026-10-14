import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

export type ApiKind = 'class' | 'interface' | 'function' | 'namespace' | 'type' | 'variable';
export type MemberKind = 'method' | 'property' | 'constructor';

export interface SourceLocation {
  file: string;
  line: number;
  endLine: number;
}

export interface ApiParameter {
  name: string;
  type: string;
  description: string;
  optional: boolean;
  rest: boolean;
}

export interface ApiTypeParameter {
  name: string;
  constraint?: string;
  default?: string;
}

export interface ApiOverload {
  signature: string;
  summary: string;
  description: string;
  parameters: ApiParameter[];
  returns?: string;
  typeParameters?: ApiTypeParameter[];
  tags?: Array<{ name: string; text: string }>;
  example?: string;
  source: SourceLocation;
}

export interface ApiMember {
  id: string;
  name: string;
  kind: MemberKind;
  summary: string;
  description?: string;
  tags?: Array<{ name: string; text: string }>;
  example?: string;
  signature: string;
  parameters: ApiParameter[];
  returns?: string;
  source: SourceLocation;
  static?: boolean;
  optional?: boolean;
  deprecated?: boolean;
  typeParameters?: ApiTypeParameter[];
  overloads?: ApiOverload[];
  inheritedFrom?: string;
}

export interface ApiSymbol {
  id: string;
  name: string;
  kind: ApiKind;
  summary: string;
  description: string;
  namespace?: string;
  signatures: string[];
  parameters?: ApiParameter[];
  returns?: string;
  tags?: Array<{ name: string; text: string }>;
  example?: string;
  typeParameters?: ApiTypeParameter[];
  overloads?: ApiOverload[];
  source: SourceLocation;
  members: ApiMember[];
}

export interface ApiVersion {
  version: string;
  label: 'Latest' | 'Previous';
  sourcePath: string;
  sourceText: string;
  symbols: ApiSymbol[];
}

export interface SourceVersion {
  version: string;
  label: 'Latest' | 'Previous';
  sourcePath: string;
}

export interface ApiDocument {
  packageName: 'webpack';
  versions: ApiVersion[];
}

export interface ApiDiagnostic {
  file: string;
  line?: number;
  column?: number;
  code: number;
  category: 'warning' | 'error' | 'suggestion' | 'message';
  message: string;
}

export interface DocumentationProgram {
  program: ts.Program;
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  sourcePath: string;
}

interface CollectedSymbol {
  symbol: ts.Symbol;
  declaration: ts.Declaration;
  declarations: ts.Declaration[];
  kind: ApiKind;
  name: string;
  namespacePath: string[];
  id: string;
}

const typeFormatFlags =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.UseFullyQualifiedType;

/** Create a real TypeScript program and fail when its input has diagnostics. */
export function createDocumentationProgram(filePath: string): DocumentationProgram {
  const sourcePath = path.resolve(filePath);
  const program = ts.createProgram({
    rootNames: [sourcePath],
    options: {
      noEmit: true,
      noEmitOnError: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
  });
  const sourceFile = program.getSourceFile(sourcePath);
  if (!sourceFile) {
    throw new Error(`TypeScript could not load ${sourcePath}`);
  }

  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: fileName => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }));
  }

  return { program, sourceFile, checker: program.getTypeChecker(), sourcePath };
}

/** Collect compiler diagnostics without throwing, for the workbench diagnostics page. */
export function getDeclarationDiagnostics(filePath: string, rootDirectory = path.dirname(path.resolve(filePath))): ApiDiagnostic[] {
  const sourcePath = path.resolve(filePath);
  const program = ts.createProgram({
    rootNames: [sourcePath],
    options: {
      noEmit: true,
      noEmitOnError: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
    },
  });
  return ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const start = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return {
      file: diagnostic.file ? toPosix(path.relative(rootDirectory, diagnostic.file.fileName)) : '<compiler>',
      ...(start ? { line: start.line + 1, column: start.character + 1 } : {}),
      code: diagnostic.code,
      category: diagnosticCategory(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    };
  });
}

function diagnosticCategory(category: ts.DiagnosticCategory): ApiDiagnostic['category'] {
  return category === ts.DiagnosticCategory.Error ? 'error'
    : category === ts.DiagnosticCategory.Warning ? 'warning'
      : category === ts.DiagnosticCategory.Suggestion ? 'suggestion' : 'message';
}

/** Extract one version of the public declaration surface. */
export function extractVersion(version: SourceVersion, rootDirectory = process.cwd()): ApiVersion {
  const sourcePath = path.resolve(rootDirectory, version.sourcePath);
  const documentationProgram = createDocumentationProgram(sourcePath);
  const relativeSourcePath = toPosix(path.relative(rootDirectory, sourcePath));
  return {
    version: version.version,
    label: version.label,
    sourcePath: relativeSourcePath,
    sourceText: documentationProgram.sourceFile.text,
    symbols: extractSymbols(documentationProgram, relativeSourcePath),
  };
}

/** Extract the complete bundled API document in the requested version order. */
export function extractApi(
  versions: SourceVersion[],
  rootDirectory = process.cwd(),
): ApiDocument {
  return {
    packageName: 'webpack',
    versions: versions.map(version => extractVersion(version, rootDirectory)),
  };
}

function extractSymbols(documentationProgram: DocumentationProgram, sourcePath: string): ApiSymbol[] {
  const { sourceFile, checker } = documentationProgram;
  const entries: CollectedSymbol[] = [];
  const bySymbol = new Map<ts.Symbol, CollectedSymbol>();

  const add = (
    declaration: ts.Declaration,
    kind: ApiKind,
    namespacePath: string[],
    nameNode: ts.Identifier | ts.StringLiteral,
  ): CollectedSymbol | undefined => {
    const symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) return undefined;
    const existing = bySymbol.get(symbol);
    if (existing) {
      existing.declarations = uniqueDeclarations(existing.declarations.concat(declaration));
      return existing;
    }
    const publicPath = namespacePath[0] === 'webpack' ? namespacePath.slice(1) : namespacePath;
    const id = publicPath.length > 0 ? `${publicPath.join('.')}.${nameNode.text}` : nameNode.text;
    const entry: CollectedSymbol = {
      symbol,
      declaration,
      declarations: [declaration],
      kind,
      name: nameNode.text,
      namespacePath,
      id,
    };
    bySymbol.set(symbol, entry);
    entries.push(entry);
    return entry;
  };

  const visitModule = (module: ts.ModuleDeclaration, namespacePath: string[]): void => {
    const moduleName = module.name;
    if (!ts.isIdentifier(moduleName)) return;
    const entry = add(module, 'namespace', namespacePath, moduleName);
    const nextPath = namespacePath.concat(moduleName.text);
    const body = module.body;
    if (body && ts.isModuleDeclaration(body)) {
      visitModule(body, nextPath);
    } else if (body && ts.isModuleBlock(body)) {
      for (const statement of body.statements) visitDeclaration(statement, nextPath);
    }
    if (entry) entry.declarations = uniqueDeclarations(entry.declarations);
  };

  const visitDeclaration = (declaration: ts.Statement, namespacePath: string[]): void => {
    if (ts.isModuleDeclaration(declaration)) {
      // The root `webpack` namespace is merged with the callable webpack function
      // and is represented by that function rather than as a duplicate symbol.
      if (namespacePath.length === 0 && declaration.name.getText(sourceFile) === 'webpack') {
        const body = declaration.body;
        if (body && ts.isModuleDeclaration(body)) {
          visitModule(body, ['webpack']);
        } else if (body && ts.isModuleBlock(body)) {
          for (const statement of body.statements) visitDeclaration(statement, ['webpack']);
        }
      } else {
        visitModule(declaration, namespacePath);
      }
      return;
    }
    if (ts.isFunctionDeclaration(declaration) && declaration.name) {
      add(declaration, 'function', namespacePath, declaration.name);
      return;
    }
    if (ts.isClassDeclaration(declaration) && declaration.name) {
      add(declaration, 'class', namespacePath, declaration.name);
      return;
    }
    if (ts.isInterfaceDeclaration(declaration)) {
      add(declaration, 'interface', namespacePath, declaration.name);
      return;
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      add(declaration, 'type', namespacePath, declaration.name);
      return;
    }
    if (ts.isVariableStatement(declaration)) {
      for (const item of declaration.declarationList.declarations) {
        if (ts.isIdentifier(item.name)) add(item, 'variable', namespacePath, item.name);
      }
    }
  };

  for (const statement of sourceFile.statements) visitDeclaration(statement, []);

  const output = entries.map(entry => makeSymbol(entry, documentationProgram, sourcePath, entries));
  output.sort((a, b) => symbolSortKey(a).localeCompare(symbolSortKey(b)));
  return output;
}

function makeSymbol(
  entry: CollectedSymbol,
  documentationProgram: DocumentationProgram,
  sourcePath: string,
  allEntries: CollectedSymbol[],
): ApiSymbol {
  const { checker, sourceFile } = documentationProgram;
  const declaration = entry.declaration;
  const documentation = getDocumentation(checker, entry.symbol);
  const callableDeclarations = publicSignatures(entry.declarations.filter(ts.isFunctionDeclaration));
  const signatures = callableDeclarations.length > 0
    ? callableDeclarations.map(item => signatureForDeclaration(checker, item, entry.name))
    : [declarationSignature(checker, declaration, entry.kind, entry.name)];
  const firstSignatureDeclaration = callableDeclarations[0] ?? declaration;
  const parameters = callableDeclarations.length > 0
    ? collectParameters(checker, callableDeclarations, documentation)
    : undefined;
  const overloads = callableDeclarations.length > 1
    ? callableDeclarations.map(declaration => overloadForDeclaration(checker, declaration, entry.name, sourcePath))
    : undefined;
  const typeParameters = typeParametersForDeclaration(checker, firstSignatureDeclaration);
  const members = getMembers(entry, documentationProgram, sourcePath, allEntries);
  const nestedEntries = allEntries.filter(candidate =>
    candidate.namespacePath.length === entry.namespacePath.length + 1 &&
    candidate.namespacePath.slice(0, entry.namespacePath.length + 1).join('.') ===
      entry.namespacePath.concat(entry.name).join('.'));
  if (entry.kind === 'namespace') {
    members.push(...nestedEntries.flatMap(nested => namespaceMember(nested, documentationProgram, sourcePath)));
    members.sort((a, b) => a.source.line - b.source.line || a.id.localeCompare(b.id));
  }

  const result: ApiSymbol = {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    summary: documentation.summary,
    description: documentation.description,
    ...(entry.namespacePath.length > 0 ? { namespace: entry.namespacePath.join('.') } : {}),
    signatures,
    ...(parameters && parameters.length > 0 ? { parameters } : {}),
    ...(typeParameters.length > 0 ? { typeParameters } : {}),
    ...(overloads ? { overloads } : {}),
    ...(returnsForDeclaration(checker, firstSignatureDeclaration, entry.kind)
      ? { returns: returnsForDeclaration(checker, firstSignatureDeclaration, entry.kind) }
      : {}),
    ...(documentation.tags.length > 0 ? { tags: documentation.tags } : {}),
    ...(documentation.example ? { example: documentation.example } : {}),
    source: sourceLocation(sourceFile, declaration, sourcePath),
    members,
  };
  return result;
}

function getMembers(
  entry: CollectedSymbol,
  documentationProgram: DocumentationProgram,
  sourcePath: string,
  allEntries: CollectedSymbol[],
): ApiMember[] {
  if (entry.kind !== 'class' && entry.kind !== 'interface') return [];
  const declaration = entry.declaration;
  if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) return [];
  const { checker } = documentationProgram;
  const candidates: MemberCandidate[] = [];
  const byKey = new Map<string, MemberCandidate>();

  const addCandidate = (
    member: ts.TypeElement | ts.ClassElement,
    inheritedFrom?: string,
  ): void => {
    const key = memberKey(member);
    if (!key) return;
    const existing = byKey.get(key);
    if (existing) {
      existing.declarations = uniqueDeclarations(existing.declarations.concat(member));
      return;
    }
    const memberSymbol = member.name ? checker.getSymbolAtLocation(member.name) : undefined;
    const symbolDeclarations = memberSymbol?.declarations?.filter(isMemberDeclaration) ?? [];
    const declarations = symbolDeclarations.length > 0 ? symbolDeclarations : [member];
    const candidate: MemberCandidate = {
      member,
      declarations,
      inheritedFrom,
    };
    byKey.set(key, candidate);
    candidates.push(candidate);
  };

  for (const item of entry.declarations) {
    if (ts.isClassDeclaration(item) || ts.isInterfaceDeclaration(item)) {
      for (const member of item.members) addCandidate(member);
    }
  }

  // The checker exposes inherited properties and methods, including members
  // inherited through an interface or a class. Their declarations remain the
  // source of truth for docs, signatures, and source locations.
  const ownerType = checker.getTypeAtLocation(declaration.name ?? declaration);
  const ownSymbols = new Set(
    declaration.members
      .map(member => member.name ? checker.getSymbolAtLocation(member.name) : undefined)
      .filter((symbol): symbol is ts.Symbol => !!symbol),
  );
  const staticType = entry.kind === 'class'
    ? checker.getTypeOfSymbolAtLocation(entry.symbol, declaration) : undefined;
  for (const memberSymbol of [
    ...checker.getPropertiesOfType(ownerType),
    ...(staticType ? checker.getPropertiesOfType(staticType) : []),
  ]) {
    if (ownSymbols.has(memberSymbol)) continue;
    const inheritedDeclarations = (memberSymbol.declarations ?? []).filter(isMemberDeclaration);
    const representative = inheritedDeclarations[0];
    if (!representative) continue;
    const inheritedFrom = inheritedOwnerId(representative, allEntries);
    if (inheritedFrom === entry.id) continue;
    const key = memberKey(representative);
    if (key && byKey.has(key)) continue;
    addCandidate(representative, inheritedFrom);
    const candidate = key ? byKey.get(key) : undefined;
    if (candidate) {
      candidate.declarations = uniqueDeclarations(inheritedDeclarations);
      candidate.inheritedFrom = inheritedFrom;
      candidate.resolvedSymbol = memberSymbol;
    }
  }

  return candidates
    .sort((a, b) => memberSortKey(a).localeCompare(memberSortKey(b)))
    .map(candidate => makeMember(
      entry,
      candidate.member,
      documentationProgram,
      sourcePath,
      candidate.declarations,
      candidate.inheritedFrom,
      candidate.resolvedSymbol,
    ));
}

interface MemberCandidate {
  member: ts.TypeElement | ts.ClassElement;
  declarations: Array<ts.TypeElement | ts.ClassElement>;
  inheritedFrom?: string;
  resolvedSymbol?: ts.Symbol;
}

function memberKey(member: ts.TypeElement | ts.ClassElement): string | undefined {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (ts.isCallSignatureDeclaration(member)) return 'call';
  if (ts.isIndexSignatureDeclaration(member)) return 'index';
  if (!member.name) return undefined;
  const name = memberNameText(member, member.getSourceFile());
  const isStatic = ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
  return `${isStatic ? 'static:' : 'instance:'}${name}`;
}

function memberSortKey(candidate: MemberCandidate): string {
  const inherited = candidate.inheritedFrom ? `1:${candidate.inheritedFrom}` : '0:';
  return `${inherited}:${candidate.member.getSourceFile().fileName}:${String(candidate.member.getStart()).padStart(10, '0')}`;
}

function isMemberDeclaration(node: ts.Declaration): node is ts.TypeElement | ts.ClassElement {
  return ts.isTypeElement(node) || ts.isClassElement(node);
}

function isCallableMemberDeclaration(
  node: ts.TypeElement | ts.ClassElement,
): node is ts.MethodDeclaration | ts.MethodSignature | ts.ConstructorDeclaration |
  ts.ConstructSignatureDeclaration | ts.CallSignatureDeclaration {
  return ts.isMethodDeclaration(node) || ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) || ts.isConstructSignatureDeclaration(node) ||
    ts.isCallSignatureDeclaration(node);
}

function inheritedOwnerId(
  declaration: ts.TypeElement | ts.ClassElement,
  entries: CollectedSymbol[],
): string | undefined {
  const parent = declaration.parent;
  if (!ts.isClassDeclaration(parent) && !ts.isInterfaceDeclaration(parent)) return undefined;
  return entries.find(entry => entry.declarations.includes(parent))?.id;
}

function namespaceMember(
  entry: CollectedSymbol,
  documentationProgram: DocumentationProgram,
  sourcePath: string,
): ApiMember[] {
  const documentation = getDocumentation(documentationProgram.checker, entry.symbol);
  const declaration = entry.declaration;
  const callableDeclarations = publicSignatures(entry.declarations.filter(ts.isFunctionDeclaration));
  const typeParameters = typeParametersForDeclaration(documentationProgram.checker, declaration);
  if (callableDeclarations.length > 0) {
    const first = callableDeclarations[0];
    const documentation = declarationDocumentation(first);
    return [{
      id: entry.id,
      name: entry.name,
      kind: 'method',
      summary: documentation.summary,
      ...(documentation.description ? { description: documentation.description } : {}),
      ...(documentation.tags.length > 0 ? { tags: documentation.tags } : {}),
      ...(documentation.example ? { example: documentation.example } : {}),
      signature: signatureForDeclaration(documentationProgram.checker, first, entry.name),
      parameters: collectMemberParameters(documentationProgram.checker, first, documentation),
      ...(typeParameters.length > 0 ? { typeParameters } : {}),
      ...(callableDeclarations.length > 1
        ? { overloads: callableDeclarations.map(item => overloadForDeclaration(documentationProgram.checker, item, entry.name, sourcePath)) }
        : {}),
      ...(methodReturnType(documentationProgram.checker, first)
        ? { returns: methodReturnType(documentationProgram.checker, first) } : {}),
      source: sourceLocation(first.getSourceFile(), first, sourcePath),
    }];
  }
  return [{
    id: entry.id,
    name: entry.name,
    kind: entry.kind === 'class' ? 'method' : 'property',
    summary: documentation.summary,
    ...(documentation.description ? { description: documentation.description } : {}),
    ...(documentation.tags.length > 0 ? { tags: documentation.tags } : {}),
    ...(documentation.example ? { example: documentation.example } : {}),
    signature: declarationSignature(documentationProgram.checker, declaration, entry.kind, entry.name),
    parameters: [],
    ...(typeParameters.length > 0 ? { typeParameters } : {}),
    source: sourceLocation(documentationProgram.sourceFile, declaration, sourcePath),
  }];
}

function makeMember(
  owner: CollectedSymbol,
  originalMember: ts.TypeElement | ts.ClassElement,
  documentationProgram: DocumentationProgram,
  sourcePath: string,
  declarations: Array<ts.TypeElement | ts.ClassElement> = [originalMember],
  inheritedFrom?: string,
  resolvedSymbol?: ts.Symbol,
): ApiMember {
  const { checker } = documentationProgram;
  const overloadDeclarations = publicSignatures(declarations.filter(isCallableMemberDeclaration));
  const member = overloadDeclarations[0] ?? originalMember;
  const sourceFile = member.getSourceFile();
  const memberSourcePath = declarationSourcePath(documentationProgram.sourceFile, sourceFile, sourcePath);
  const resolvedType = resolvedSymbol ? checker.getTypeOfSymbolAtLocation(resolvedSymbol, owner.declaration) : undefined;
  const resolvedSignatures = resolvedType ? checker.getSignaturesOfType(resolvedType, ts.SignatureKind.Call) : [];
  const resolvedSignature = resolvedSignatures[0];
  const memberName = memberNameText(member, sourceFile);
  const documentation = declarationDocumentation(member);
  const isConstructor = ts.isConstructorDeclaration(member);
  const isMethod = ts.isMethodDeclaration(member) || ts.isMethodSignature(member) ||
    ts.isCallSignatureDeclaration(member) || ts.isConstructSignatureDeclaration(member) ||
    ts.isIndexSignatureDeclaration(member);
  const kind: MemberKind = isConstructor ? 'constructor' : isMethod ? 'method' : 'property';
  const signature = isConstructor
    ? signatureForDeclaration(checker, member, 'constructor')
    : isMethod
      ? signatureForDeclaration(checker, member, memberName, resolvedSignature)
      : propertySignature(checker, member, memberName, sourceFile, resolvedType);
  const parameters = isMethod || isConstructor
    ? collectMemberParameters(checker, member, documentation, resolvedSignature)
    : [];
  const returnType = isMethod
    ? methodReturnType(checker, member, resolvedSignature)
    : undefined;
  const staticMember = ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
  const optional = !!(ts.isPropertySignature(member) || ts.isPropertyDeclaration(member) || ts.isMethodSignature(member)) &&
    !!member.questionToken;
  const typeParameters = typeParametersForDeclaration(checker, member, resolvedSignature);
  const memberIdName = isConstructor
    ? 'constructor'
    : `${staticMember ? 'static:' : ''}${encodeURIComponent(memberName).replace(/\./gu, '%2E')}`;
  return {
    id: `${owner.id}.${memberIdName}`,
    name: isConstructor ? 'constructor' : memberName,
    kind,
    summary: documentation.summary,
    ...(documentation.description ? { description: documentation.description } : {}),
    ...(documentation.tags.length > 0 ? { tags: documentation.tags } : {}),
    ...(documentation.example ? { example: documentation.example } : {}),
    signature,
    parameters,
    ...(typeParameters.length > 0 ? { typeParameters } : {}),
    ...(overloadDeclarations.length > 1
      ? { overloads: overloadDeclarations.map((overload, index) => overloadForDeclaration(checker, overload, memberName, memberSourcePath, resolvedSignatures[index])) }
      : {}),
    ...(returnType ? { returns: returnType } : {}),
    source: sourceLocation(sourceFile, member, memberSourcePath),
    ...(staticMember ? { static: true } : {}),
    ...(optional ? { optional: true } : {}),
    ...(hasDeprecatedTag(documentation.tags) ? { deprecated: true } : {}),
    ...(inheritedFrom ? { inheritedFrom } : {}),
  };
}

function collectParameters(
  checker: ts.TypeChecker,
  declarations: ts.FunctionLikeDeclaration[],
  documentation: Documentation,
): ApiParameter[] {
  const parameters = new Map<string, ApiParameter>();
  for (const declaration of declarations) {
    for (const parameter of declaration.parameters) {
      const name = parameter.name.getText(declaration.getSourceFile());
      if (parameters.has(name)) continue;
      parameters.set(name, parameterInfo(checker, parameter, documentation));
    }
  }
  return [...parameters.values()];
}

function overloadForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  name: string,
  sourcePath: string,
  resolvedSignature?: ts.Signature,
): ApiOverload {
  const documentation = declarationDocumentation(declaration);
  const returns = methodReturnType(checker, declaration, resolvedSignature);
  const typeParameters = typeParametersForDeclaration(checker, declaration, resolvedSignature);
  return {
    signature: signatureForDeclaration(checker, declaration, name, resolvedSignature),
    summary: documentation.summary,
    description: documentation.description,
    parameters: collectMemberParameters(checker, declaration, documentation, resolvedSignature),
    ...(returns ? { returns } : {}),
    ...(typeParameters.length > 0 ? { typeParameters } : {}),
    ...(documentation.tags.length > 0 ? { tags: documentation.tags } : {}),
    ...(documentation.example ? { example: documentation.example } : {}),
    source: sourceLocation(declaration.getSourceFile(), declaration, sourcePath),
  };
}

function typeParametersForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Node,
  signature?: ts.Signature,
): ApiTypeParameter[] {
  if (signature?.typeParameters) {
    return signature.typeParameters.map(parameter => {
      const constraint = parameter.getConstraint();
      const defaultType = parameter.getDefault();
      return {
        name: parameter.symbol.name,
        ...(constraint ? { constraint: checker.typeToString(constraint, declaration, typeFormatFlags) } : {}),
        ...(defaultType ? { default: checker.typeToString(defaultType, declaration, typeFormatFlags) } : {}),
      };
    });
  }
  if (!ts.isFunctionLike(declaration) && !ts.isInterfaceDeclaration(declaration) &&
    !ts.isTypeAliasDeclaration(declaration) && !ts.isClassDeclaration(declaration)) return [];
  return (declaration.typeParameters ?? []).map(typeParameter => ({
    name: typeParameter.name.text,
    ...(typeParameter.constraint
      ? { constraint: typeNodeToString(checker, typeParameter.constraint) }
      : {}),
    ...(typeParameter.default
      ? { default: typeNodeToString(checker, typeParameter.default) }
      : {}),
  }));
}

function typeNodeToString(checker: ts.TypeChecker, node: ts.TypeNode): string {
  return checker.typeToString(checker.getTypeAtLocation(node), node, typeFormatFlags);
}

function collectMemberParameters(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  documentation: Documentation,
  signature?: ts.Signature,
): ApiParameter[] {
  return declaration.parameters.map((parameter, index) => {
    const result = parameterInfo(checker, parameter, documentation);
    const resolvedParameter = signature?.parameters[index];
    if (resolvedParameter) {
      result.type = checker.typeToString(checker.getTypeOfSymbolAtLocation(resolvedParameter, declaration), declaration, typeFormatFlags);
    }
    return result;
  });
}

function parameterInfo(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  documentation: Documentation,
): ApiParameter {
  const sourceFile = parameter.getSourceFile();
  const name = parameter.name.getText(sourceFile);
  const type = checker.typeToString(checker.getTypeAtLocation(parameter), parameter, typeFormatFlags);
  const description = parameterDescription(documentation.tags, name);
  return {
    name,
    type,
    description,
    optional: !!parameter.questionToken || !!parameter.initializer,
    rest: !!parameter.dotDotDotToken,
  };
}

interface Documentation {
  summary: string;
  description: string;
  tags: Array<{ name: string; text: string }>;
  example?: string;
}

function getDocumentation(checker: ts.TypeChecker, symbol: ts.Symbol): Documentation {
  const description = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  return documentationFromParts(description, symbol.getJsDocTags(checker));
}

function declarationDocumentation(declaration: ts.Node): Documentation {
  const jsDoc = ts.getJSDocCommentsAndTags(declaration).find(ts.isJSDoc);
  if (!jsDoc) return emptyDocumentation();
  const description = jsDocCommentText(jsDoc.comment);
  const tags = (jsDoc.tags ?? []).map(tag => ({
    name: tag.tagName.text,
    text: jsDocTagText(tag),
  }));
  return documentationFromParts(description, tags);
}

function jsDocTagText(tag: ts.JSDocTag): string {
  const comment = jsDocCommentText(tag.comment);
  if (ts.isJSDocParameterTag(tag)) {
    const name = tag.name.getText(tag.getSourceFile());
    return [name, comment].filter(Boolean).join(' ');
  }
  return comment;
}

function jsDocCommentText(comment: string | ts.NodeArray<ts.JSDocComment> | undefined): string {
  if (typeof comment === 'string') return comment.trim();
  return (comment ?? []).map(part => part.kind === ts.SyntaxKind.JSDocText ? part.text : part.getText()).join('').trim();
}

function documentationFromParts(
  description: string,
  rawTags: readonly ts.JSDocTagInfo[] | readonly { name: string; text: string }[],
): Documentation {
  const tags = rawTags.map(tag => ({ name: tag.name, text: jsDocText(tag.text) }));
  const example = tags.find(tag => tag.name === 'example')?.text;
  return {
    summary: summaryFrom(description),
    description,
    tags,
    ...(example ? { example } : {}),
  };
}

function emptyDocumentation(): Documentation {
  return { summary: '', description: '', tags: [] };
}

function jsDocText(text: string | ts.SymbolDisplayPart[] | undefined): string {
  return typeof text === 'string' ? text.trim() : ts.displayPartsToString(text ?? []).trim();
}

function summaryFrom(description: string): string {
  const paragraph = description.split(/\n\s*\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  const sentence = paragraph.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim();
  return sentence || paragraph;
}

function signatureForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  name: string,
  resolvedSignature?: ts.Signature,
): string {
  const signature = resolvedSignature ?? checker.getSignatureFromDeclaration(declaration);
  if (!signature) return declaration.getText(declaration.getSourceFile());
  return `${name}${checker.signatureToString(signature, declaration, typeFormatFlags)}`;
}

function declarationSignature(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  kind: ApiKind,
  name: string,
): string {
  if (kind === 'function' && ts.isFunctionDeclaration(declaration)) {
    return signatureForDeclaration(checker, declaration, name);
  }
  if (kind === 'type' && ts.isTypeAliasDeclaration(declaration)) {
    const typeParameters = typeParameterText(declaration.typeParameters);
    return `type ${name}${typeParameters} = ${declaration.type?.getText(declaration.getSourceFile()) ?? 'unknown'}`;
  }
  if (kind === 'interface' && ts.isInterfaceDeclaration(declaration)) {
    const heritage = declaration.heritageClauses?.map(clause => clause.getText()).join(' ') ?? '';
    const typeParameters = typeParameterText(declaration.typeParameters);
    return `interface ${name}${typeParameters}${heritage ? ` ${heritage}` : ''}`;
  }
  if (kind === 'class' && ts.isClassDeclaration(declaration)) {
    const heritage = declaration.heritageClauses?.map(clause => clause.getText()).join(' ') ?? '';
    return `class ${name}${typeParameterText(declaration.typeParameters)}${heritage ? ` ${heritage}` : ''}`;
  }
  if (kind === 'namespace') return `namespace ${name}`;
  if (kind === 'variable' && ts.isVariableDeclaration(declaration)) {
    const type = declaration.type?.getText(declaration.getSourceFile()) ?? 'unknown';
    return `const ${name}: ${type}`;
  }
  return name;
}

function typeParameterText(typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): string {
  return typeParameters && typeParameters.length > 0
    ? `<${typeParameters.map(parameter => parameter.getText()).join(', ')}>`
    : '';
}

function propertySignature(
  checker: ts.TypeChecker,
  member: ts.TypeElement | ts.ClassElement,
  name: string,
  sourceFile: ts.SourceFile,
  resolvedType?: ts.Type,
): string {
  const optional = (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) && member.questionToken
    ? '?'
    : '';
  const type = checker.typeToString(resolvedType ?? checker.getTypeAtLocation(member), member, typeFormatFlags);
  const readonly = (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
    member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
    ? 'readonly ' : '';
  return `${readonly}${name}${optional}: ${type}`;
}

function methodReturnType(checker: ts.TypeChecker, declaration: ts.SignatureDeclaration, resolvedSignature?: ts.Signature): string | undefined {
  const signature = resolvedSignature ?? checker.getSignatureFromDeclaration(declaration);
  return signature ? checker.typeToString(signature.getReturnType(), declaration, typeFormatFlags) : undefined;
}

function returnsForDeclaration(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  kind: ApiKind,
): string | undefined {
  return kind === 'function' && ts.isFunctionDeclaration(declaration)
    ? methodReturnType(checker, declaration)
    : undefined;
}

function memberNameText(member: ts.TypeElement | ts.ClassElement, sourceFile: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  if (ts.isCallSignatureDeclaration(member)) return '(call)';
  if (ts.isIndexSignatureDeclaration(member)) return '(index)';
  if (member.name) {
    return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
      ? member.name.text : member.name.getText(sourceFile);
  }
  return '(anonymous)';
}

function declarationSourcePath(rootSource: ts.SourceFile, declarationSource: ts.SourceFile, rootPath: string): string {
  return path.posix.normalize(path.posix.join(
    path.posix.dirname(rootPath),
    toPosix(path.relative(path.dirname(rootSource.fileName), declarationSource.fileName)),
  ));
}

function sourceLocation(sourceFile: ts.SourceFile, node: ts.Node, file: string): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return { file, line: start.line + 1, endLine: end.line + 1 };
}

function hasDeprecatedTag(tags: Array<{ name: string; text: string }>): boolean {
  return tags.some(tag => tag.name === 'deprecated');
}

function parameterDescription(tags: Array<{ name: string; text: string }>, name: string): string {
  const tag = tags.find(item => item.name === 'param' && item.text.split(/\s+/u)[0] === name);
  return tag?.text.replace(/^\S+\s*/u, '').trim() ?? '';
}

function uniqueDeclarations<T extends ts.Declaration>(declarations: T[]): T[] {
  return [...new Set(declarations)];
}

function publicSignatures<T extends ts.SignatureDeclaration>(declarations: T[]): T[] {
  const signatures = declarations.filter(declaration => !('body' in declaration && declaration.body));
  return signatures.length > 0 ? signatures : declarations;
}

function symbolSortKey(symbol: ApiSymbol): string {
  // Keeping Compiler first makes the generated catalog open on the primary UI.
  if (symbol.id === 'Compiler') return '0000';
  return `${symbol.source.file}:${String(symbol.source.line).padStart(6, '0')}:${symbol.id}`;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

// Keep fs imported in this module's public implementation boundary so callers
// can pass paths from generated manifests without having to normalize them.
export function sourceExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
