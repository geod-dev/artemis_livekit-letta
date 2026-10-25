#!/usr/bin/env node
/**
 * Mechanical enforcement of the dependency rules (docs/architecture.md,
 * "Dependency rules"). Parses every source file under apps/ and packages/
 * (.ts .tsx .mts .cts .mjs .cjs .js .jsx, declaration files and generated
 * directories included) with the root `typescript` compiler API and checks each
 * import and export specifier against the rules below. Prints one line per
 * violation as `file:line rule-N message` and exits 1 when there is any.
 *
 *   rule-1  packages/contracts imports nothing outside itself; no runtime deps.
 *   rule-2  packages/* never import apps/*, nor reach a vendor path outside
 *           their own src/vendor; relative imports stay inside the package.
 *   rule-3  apps/* never import another app, nor a relative path that leaves
 *           their own root.
 *   rule-4  only apps/<app>/src/compose.ts imports a vendor implementation.
 *   rule-5  apps/web imports only @artemis/contracts among workspace packages;
 *           apps/web/src imports no Node built-in and no server-only SDK.
 *   rule-6  every bare import is declared in the importing package.json. Shipped
 *           code (non-test files under a package's src/) may use only dependencies
 *           and peerDependencies; devDependencies count for test files, package-root
 *           config files and the root tooling under scripts/, none of which ships.
 *   rule-7  the workspace package graph (workspace:/link: references) is acyclic.
 *   rule-8  a vendor SDK (VENDOR_NPM_PACKAGES, derived from the dependencies of
 *           the packages that hold a src/vendor folder) is imported only from
 *           src/vendor and from apps/<app>/src/compose.ts.
 *   rule-9  non-test code imports no testing module (`*\/testing` subpaths).
 *   rule-10 scripts/ (tooling) imports only the files named in TOOLING_IMPORTS,
 *           a package's src/index.ts, or a package subpath export.
 *
 * Test code (`*.test.*` files and anything under a `test/` or `testing/`
 * directory) is exempt from rule-4, rule-8, rule-9 and the apps/web/src half of
 * rule-5: tests build fixtures from the vendor testing subpaths and fake
 * servers, and web tests run under node itself. Reviewed exceptions live in
 * ALLOWLIST; it is empty.
 *
 * `--self-test` runs the checker on small synthetic fixtures, one per rule,
 * and exits 1 if any rule fails to fire or the clean fixture is flagged.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
/** The fields a shipped package installs at runtime. */
const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const BUILTIN_MODULES = new Set(builtinModules);
const CONTRACTS_NAME = '@artemis/contracts';
const WEB_DIRECTORY = 'apps/web';
const CONTRACTS_DIRECTORY = 'packages/contracts';
const COMPOSE_FILE = /^apps\/[^/]+\/src\/compose\.ts$/;

/**
 * Reviewed exceptions to rule-10 (tooling imports). Each entry names the
 * importing file and the one file it may reach that is not an index or a
 * subpath export. The schema generator reads the web component library: the
 * generator is the only code outside apps/web that may import it (decision 14).
 */
const TOOLING_IMPORTS = [
  {
    from: 'scripts/generate-present-tool.ts',
    target: 'apps/web/src/lib/present-library.ts',
    reason: 'the schema generator reads the web component library (decision 1)',
  },
];

/**
 * Reviewed exceptions. Each entry names the file (posix path from the repo
 * root), the rule, the exact specifier, and the reason. Keep this list empty
 * unless a violation is genuinely intended.
 */
const ALLOWLIST = [];

/** `src/vendor/**` in a package: the only place a vendor implementation lives (apps have none). */
function isVendorFile(rel) {
  return /^packages\/[^/]+\/src\/vendor\//.test(rel);
}

/** `*.test.*` files, and anything under a `test/` or `testing/` directory. */
function isTestFile(rel) {
  return /\.test\.[cm]?[jt]sx?$/.test(rel) || /(^|\/)(test|testing)\//.test(rel);
}

function posixRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isInside(directory, target) {
  const rel = relative(directory, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function discoverPackages(root) {
  const packages = [];
  for (const kind of ['apps', 'packages']) {
    const kindDirectory = join(root, kind);
    if (!existsSync(kindDirectory)) continue;
    for (const entry of readdirSync(kindDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(kindDirectory, entry.name);
      const manifest = join(directory, 'package.json');
      if (!existsSync(manifest)) continue;
      packages.push({
        directory,
        rel: posixRelative(root, directory),
        kind,
        manifest,
        json: readJson(manifest),
      });
    }
  }
  for (const pkg of packages) pkg.name = pkg.json.name;
  return packages;
}

function listSourceFiles(directory, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) listSourceFiles(path, out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

const SCRIPT_KINDS = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

/** Every module specifier in a file: static and re-exports, require(), import(), import types. */
function collectSpecifiers(file, text) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[extname(file)]);
  const found = [];
  const add = (literal) => {
    found.push({
      specifier: literal.text,
      line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
    });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0]);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function firstTarget(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const target = firstTarget(nested);
      if (target) return target;
    }
  }
  return undefined;
}

/** The file a package subpath (".", "./x") resolves to through its `exports` map. */
function exportTarget(exportsField, subpath) {
  if (exportsField === undefined) return undefined;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : undefined;
  if (exportsField[subpath] !== undefined) return firstTarget(exportsField[subpath]);
  for (const key of Object.keys(exportsField)) {
    const star = key.indexOf('*');
    if (star < 0 || !key.startsWith('.')) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length >= prefix.length + suffix.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
      return firstTarget(exportsField[key])?.replaceAll('*', matched);
    }
  }
  return undefined;
}

/** Splits a bare specifier into its package name and "./subpath" form. */
function splitBare(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const rest = specifier.slice(name.length);
  return { name, subpath: rest ? `.${rest}` : '.' };
}

/**
 * The `compilerOptions.paths` aliases of a package's own tsconfig.json (for
 * example apps/web's `@/*` for its src). An alias stays inside its package, so
 * it is checked like a relative import rather than a dependency.
 */
function pathAliases(pkg) {
  const tsconfig = join(pkg.directory, 'tsconfig.json');
  if (!existsSync(tsconfig)) return [];
  const { config } = ts.readConfigFile(tsconfig, ts.sys.readFile);
  return Object.entries(config?.compilerOptions?.paths ?? {}).map(([pattern, targets]) => ({
    prefix: pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern,
    exact: !pattern.endsWith('/*'),
    target: targets[0],
  }));
}

function aliasTarget(pkg, specifier, aliases) {
  for (const alias of aliases) {
    if (alias.exact) {
      if (specifier === alias.prefix) return resolve(pkg.directory, alias.target);
    } else if (specifier.startsWith(alias.prefix)) {
      const rest = specifier.slice(alias.prefix.length);
      return resolve(pkg.directory, alias.target.replace(/\*$/, rest));
    }
  }
  return undefined;
}

function declaredNames(json, fields = DEPENDENCY_FIELDS) {
  const names = new Set();
  for (const field of fields) {
    for (const name of Object.keys(json[field] ?? {})) names.add(name);
  }
  return names;
}

function checkTree(root) {
  const packages = discoverPackages(root);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const violations = [];
  let allowed = 0;
  let filesChecked = 0;

  // The root manifest declares the tooling's packages. scripts/ is tooling, not a package.
  const tooling = {
    directory: join(root, 'scripts'),
    rel: 'scripts',
    kind: 'tooling',
    json: existsSync(join(root, 'package.json')) ? readJson(join(root, 'package.json')) : {},
  };

  // rule-8's SDK list: the external dependencies of every package that holds a vendor folder.
  const VENDOR_NPM_PACKAGES = new Set(
    packages
      .filter((pkg) => pkg.kind === 'packages' && existsSync(join(pkg.directory, 'src', 'vendor')))
      .flatMap((pkg) => Object.keys({ ...pkg.json.dependencies, ...pkg.json.peerDependencies }))
      .filter((name) => !packagesByName.has(name))
  );

  const report = (file, line, rule, message, specifier) => {
    const entry = ALLOWLIST.find(
      (item) => item.file === file && item.rule === rule && item.specifier === specifier
    );
    if (entry) {
      allowed += 1;
      return;
    }
    violations.push({ file, line, rule, message });
  };

  const packageOf = (path) => packages.find((pkg) => isInside(pkg.directory, path));

  // The vendor implementation a path belongs to: packages/<name>/src/vendor.
  const vendorDirectoryOf = (path) => {
    const rel = posixRelative(root, path);
    if (!isVendorFile(rel)) return undefined;
    return join(root, ...rel.split('/').slice(0, 4));
  };

  for (const pkg of packages) {
    if (pkg.rel === CONTRACTS_DIRECTORY) {
      const runtime = Object.keys({ ...pkg.json.dependencies, ...pkg.json.peerDependencies, ...pkg.json.optionalDependencies });
      if (runtime.length > 0) {
        report(posixRelative(root, pkg.manifest), 1, 'rule-1', `contracts declares runtime dependencies: ${runtime.join(', ')}`, '');
      }
    }
    // No package depends on an app, in any dependency field.
    if (pkg.kind === 'packages') {
      for (const field of DEPENDENCY_FIELDS) {
        for (const name of Object.keys(pkg.json[field] ?? {})) {
          if (packagesByName.get(name)?.kind === 'apps') {
            report(posixRelative(root, pkg.manifest), 1, 'rule-1', `packages must not depend on apps (${field}: "${name}")`, name);
          }
        }
      }
    }
  }

  for (const owner of [...packages, ...(existsSync(tooling.directory) ? [tooling] : [])]) {
    const aliases = pathAliases(owner);
    for (const file of listSourceFiles(owner.directory)) {
      const rel = posixRelative(root, file);
      filesChecked += 1;
      const text = readFileSync(file, 'utf8');

      // rule-4: vendor code lives only in packages/<name>/src/vendor.
      if (/(^|\/)vendor\//.test(rel) && !isVendorFile(rel)) {
        report(rel, 1, 'rule-4', 'vendor code must live in packages/<name>/src/vendor', '');
      }

      // Shipped code (non-test files under a package's src/) checks only runtime dependencies. Test
      // files, config files at a package root (vite, eslint) and scripts/ are tooling and may use devDependencies.
      const shipped = owner.kind === 'packages' || owner.kind === 'apps'
        ? rel.startsWith(`${owner.rel}/src/`) && !isTestFile(rel)
        : false;
      const declared = declaredNames(owner.json, shipped ? RUNTIME_FIELDS : DEPENDENCY_FIELDS);

      // Browser code under apps/web/src: no Node built-ins, no server-only SDKs (rule-5).
      // Web tests run under node itself, so they are excepted.
      const webSource =
        owner.rel === WEB_DIRECTORY && rel.startsWith(`${WEB_DIRECTORY}/src/`) && !isTestFile(rel);

      for (const { specifier, line } of collectSpecifiers(file, text)) {
        if (specifier.startsWith('node:') || BUILTIN_MODULES.has(specifier)) {
          if (webSource) {
            report(rel, line, 'rule-5', `apps/web/src must not import the Node built-in "${specifier}"`, specifier);
          }
          continue;
        }

        let absoluteTarget;
        let targetPackage;
        let bare;
        const alias = aliasTarget(owner, specifier, aliases);
        const relative = specifier.startsWith('.') || alias !== undefined;
        if (relative) {
          absoluteTarget = alias ?? resolve(dirname(file), specifier);
          targetPackage = packageOf(absoluteTarget);
        } else if (specifier.startsWith('/')) {
          report(rel, line, 'rule-2', `absolute import path "${specifier}" is not allowed`, specifier);
          continue;
        } else {
          bare = splitBare(specifier);
          targetPackage = packagesByName.get(bare.name);
          if (targetPackage) {
            const target = exportTarget(targetPackage.json.exports, bare.subpath);
            absoluteTarget = target ? join(targetPackage.directory, target) : undefined;
          }
          if (!declared.has(bare.name)) {
            report(rel, line, 'rule-6', `"${bare.name}" is not declared in ${owner.rel}/package.json`, specifier);
          }
          if (VENDOR_NPM_PACKAGES.has(bare.name)) {
            if (webSource) {
              report(rel, line, 'rule-5', `apps/web/src must not import the server-only SDK "${bare.name}"`, specifier);
            } else if (!isVendorFile(rel) && !COMPOSE_FILE.test(rel) && !isTestFile(rel)) {
              report(rel, line, 'rule-8', `vendor SDK "${bare.name}" imported outside src/vendor and apps/*/src/compose.ts`, specifier);
            }
          }
        }

        // rule-9: non-test code never imports a testing module (a fixture or test double).
        if (!isTestFile(rel) && /(^|\/)testing(\/|$)/.test(specifier)) {
          report(rel, line, 'rule-9', `non-test code must not import a testing module ("${specifier}")`, specifier);
        }

        const leavesOwner = absoluteTarget !== undefined && !isInside(owner.directory, absoluteTarget);
        const crossesOwner = (targetPackage !== undefined && targetPackage !== owner) || leavesOwner;

        // rule-1: contracts imports nothing outside itself.
        if (owner.rel === CONTRACTS_DIRECTORY && crossesOwner) {
          report(rel, line, 'rule-1', `contracts must not import outside itself ("${specifier}")`, specifier);
        }

        // rule-10: tooling reaches into apps and packages only through a named file, an index, or a subpath export.
        if (owner.kind === 'tooling' && absoluteTarget !== undefined && !bare) {
          const reachesWorkspace = targetPackage !== undefined || isInside(join(root, 'apps'), absoluteTarget) || isInside(join(root, 'packages'), absoluteTarget);
          const targetRel = posixRelative(root, absoluteTarget);
          const named = TOOLING_IMPORTS.some((entry) => entry.from === rel && entry.target === targetRel);
          const packageIndex = targetPackage !== undefined && targetRel === `${targetPackage.rel}/src/index.ts`;
          if (reachesWorkspace && !named && !packageIndex) {
            report(rel, line, 'rule-10', `tooling may import only a named file, a package src/index.ts, or a subpath export ("${specifier}")`, specifier);
          }
        }

        // rule-2: packages never import apps, and never reach across their own root by path.
        if (owner.kind === 'packages') {
          if (targetPackage?.kind === 'apps') {
            report(rel, line, 'rule-2', `packages must not import apps ("${specifier}")`, specifier);
          } else if (relative && leavesOwner) {
            report(rel, line, 'rule-2', `relative import leaves the package root ("${specifier}")`, specifier);
          }
        }

        // rule-3: apps never import another app, nor a path that leaves their root.
        if (owner.kind === 'apps') {
          if (targetPackage?.kind === 'apps' && targetPackage !== owner) {
            report(rel, line, 'rule-3', `apps must not import another app ("${specifier}")`, specifier);
          } else if (relative && leavesOwner) {
            report(rel, line, 'rule-3', `relative import leaves the app root ("${specifier}")`, specifier);
          }
        }

        // rule-4 and rule-2 (vendor): vendor implementations are reached only from a composition root.
        const vendorDirectory = absoluteTarget ? vendorDirectoryOf(absoluteTarget) : undefined;
        if (vendorDirectory && !isInside(vendorDirectory, file)) {
          if (!COMPOSE_FILE.test(rel) && !isTestFile(rel)) {
            report(rel, line, 'rule-4', `vendor implementation imported outside apps/*/src/compose.ts ("${specifier}")`, specifier);
          }
          if (owner.kind === 'packages') {
            report(rel, line, 'rule-2', `packages may reach a vendor path only from inside their own src/vendor ("${specifier}")`, specifier);
          }
        }

        // rule-5: apps/web imports only @artemis/contracts among workspace packages.
        if (owner.rel === WEB_DIRECTORY && bare && targetPackage && targetPackage.name !== CONTRACTS_NAME) {
          report(rel, line, 'rule-5', `apps/web may import only ${CONTRACTS_NAME} from workspace packages ("${specifier}")`, specifier);
        }
      }
    }
  }

  // rule-7: the workspace graph, from workspace:/link: references in every dependency field, is acyclic.
  const graph = new Map(packages.map((pkg) => [pkg.name, []]));
  for (const pkg of packages) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, version] of Object.entries(pkg.json[field] ?? {})) {
        const isWorkspaceReference = typeof version === 'string' && (version.startsWith('workspace:') || version.startsWith('link:'));
        if (isWorkspaceReference && packagesByName.has(name)) graph.get(pkg.name).push(name);
      }
    }
  }
  const state = new Map();
  const stack = [];
  const visit = (name) => {
    state.set(name, 'active');
    stack.push(name);
    for (const next of graph.get(name)) {
      if (state.get(next) === 'active') {
        const cycle = [...stack.slice(stack.indexOf(next)), next];
        const owner = packagesByName.get(cycle[0]);
        report(posixRelative(root, owner.manifest), 1, 'rule-7', `workspace packages form a cycle: ${cycle.join(' -> ')}`, '');
      } else if (!state.has(next)) {
        visit(next);
      }
    }
    stack.pop();
    state.set(name, 'done');
  };
  for (const name of graph.keys()) if (!state.has(name)) visit(name);

  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return { violations, allowed, filesChecked, packages: packages.length };
}

// ---------------------------------------------------------------------------
// Self-test: one fixture per rule, plus a clean fixture that must pass.

function manifest(name, dependencies = {}, exports = undefined, devDependencies = undefined) {
  const json = { name, version: '0.1.0', private: true, type: 'module', dependencies };
  if (devDependencies) json.devDependencies = devDependencies;
  if (exports) json.exports = exports;
  return `${JSON.stringify(json, null, 2)}\n`;
}

function baselineFixture() {
  return {
    'packages/core/package.json': manifest('@artemis/core'),
    'packages/core/src/index.ts': 'export const core = 1;\n',
    'packages/contracts/package.json': manifest('@artemis/contracts', {}, undefined, { typescript: '^5.9.3' }),
    'packages/contracts/src/index.ts': 'export const contract = 1;\n',
    'packages/llm/package.json': manifest(
      '@artemis/llm',
      { '@artemis/core': 'workspace:*', '@anthropic-ai/sdk': '^0.1.0' },
      { '.': './src/index.ts', './anthropic': './src/vendor/anthropic/index.ts' }
    ),
    'packages/llm/src/index.ts': "import { core } from '@artemis/core';\nexport const llm = core;\n",
    'packages/llm/src/vendor/anthropic/index.ts':
      "import '@anthropic-ai/sdk';\nexport const anthropic = 1;\n",
    'apps/gateway/package.json': manifest('@artemis/gateway', {
      '@artemis/contracts': 'workspace:*',
      '@artemis/llm': 'workspace:*',
    }),
    'apps/gateway/src/compose.ts':
      "import { anthropic } from '@artemis/llm/anthropic';\nimport { llm } from '@artemis/llm';\nexport const compose = [anthropic, llm];\n",
    'apps/gateway/src/server.ts':
      "import { compose } from './compose.ts';\nimport { contract } from '@artemis/contracts';\nexport const server = [compose, contract];\n",
    'apps/gateway/src/server.test.ts':
      "import { anthropic } from '@artemis/llm/anthropic';\nexport const testing = anthropic;\n",
    // A file under testing/ is test code: it may reach a vendor testing subpath.
    'apps/gateway/src/testing/fixtures.ts':
      "import { anthropic } from '@artemis/llm/anthropic';\nexport const fixtures = anthropic;\n",
    'packages/storage/package.json': manifest('@artemis/storage', { pg: '^8.16.0' }, { '.': './src/index.ts' }),
    'packages/storage/src/index.ts': 'export const storage = 1;\n',
    'packages/storage/src/vendor/pg/index.ts': "import 'pg';\nexport const pg = 1;\n",
    'scripts/index-import.ts':
      "import { core } from '../packages/core/src/index.ts';\nexport const tool = core;\n",
    'apps/web/package.json': manifest('@artemis/web', {
      '@artemis/contracts': 'link:../../packages/contracts',
      '@artemis/core': 'link:../../packages/core',
      react: '^19.1.1',
    }),
    'apps/web/src/main.tsx': "import { contract } from '@artemis/contracts';\nimport { useState } from 'react';\nexport const main = [contract, useState];\n",
  };
}

const FIXTURES = [
  { name: 'clean', rule: null, files: {} },
  {
    name: 'rule-1',
    rule: 'rule-1',
    files: {
      'packages/contracts/src/bad.ts': "import { core } from '@artemis/core';\nexport const bad = core;\n",
    },
  },
  {
    name: 'rule-2',
    rule: 'rule-2',
    files: {
      'packages/core/src/bad.ts': "import { server } from '../../../apps/gateway/src/server.ts';\nexport const bad = server;\n",
    },
  },
  {
    name: 'rule-3',
    rule: 'rule-3',
    files: {
      'apps/gateway/src/bad.ts': "import { main } from '../../web/src/main.tsx';\nexport const bad = main;\n",
    },
  },
  {
    name: 'rule-4',
    rule: 'rule-4',
    files: {
      'apps/gateway/src/bad.ts': "import { anthropic } from '@artemis/llm/anthropic';\nexport const bad = anthropic;\n",
    },
  },
  {
    name: 'rule-5',
    rule: 'rule-5',
    files: {
      'apps/web/src/bad.ts': "import { core } from '@artemis/core';\nexport const bad = core;\n",
    },
  },
  {
    name: 'rule-5-node-builtin',
    rule: 'rule-5',
    files: {
      'apps/web/src/bad-node.ts': "import { readFileSync } from 'node:fs';\nexport const bad = readFileSync;\n",
    },
  },
  {
    name: 'rule-5-server-sdk',
    rule: 'rule-5',
    files: {
      'apps/web/src/bad-sdk.ts': "import { Pool } from 'pg';\nexport const bad = Pool;\n",
    },
  },
  {
    name: 'rule-8',
    rule: 'rule-8',
    files: {
      'packages/core/src/bad-sdk.ts': "import { Pool } from 'pg';\nexport const bad = Pool;\n",
    },
  },
  {
    name: 'scan-generated-declaration',
    rule: 'rule-2',
    files: {
      'packages/core/src/generated/bad.d.ts': "import type { server } from '../../../../apps/gateway/src/server.ts';\nexport type Bad = typeof server;\n",
    },
  },
  {
    name: 'scan-cjs',
    rule: 'rule-2',
    files: {
      'packages/core/src/bad.cjs': "const server = require('../../../apps/gateway/src/server.ts');\nmodule.exports = server;\n",
    },
  },
  {
    name: 'rule-6',
    rule: 'rule-6',
    files: {
      'apps/gateway/src/bad.ts': "import leftPad from 'left-pad';\nexport const bad = leftPad;\n",
    },
  },
  {
    name: 'rule-7',
    rule: 'rule-7',
    files: {
      'packages/core/package.json': manifest('@artemis/core', { '@artemis/llm': 'workspace:*' }),
    },
  },
  {
    name: 'rule-1-app-dependency',
    rule: 'rule-1',
    files: {
      'packages/core/package.json': manifest('@artemis/core', {}, undefined, { '@artemis/gateway': 'workspace:*' }),
    },
  },
  {
    name: 'rule-6-dev-dependency',
    rule: 'rule-6',
    files: {
      'packages/core/package.json': manifest('@artemis/core', {}, undefined, { typescript: '^5.9.3' }),
      'packages/core/src/bad-dev.ts': "import ts from 'typescript';\nexport const bad = ts;\n",
    },
  },
  {
    name: 'rule-4-app-vendor',
    rule: 'rule-4',
    files: {
      'apps/gateway/src/vendor/bad.ts': 'export const bad = 1;\n',
    },
  },
  {
    name: 'rule-4-device-server',
    rule: 'rule-4',
    files: {
      'packages/mcp/package.json': manifest('@artemis/mcp', {}, { './device-server': './src/vendor/sdk/device-server.ts' }),
      'packages/mcp/src/vendor/sdk/device-server.ts': 'export const serve = 1;\n',
      'apps/gateway/package.json': manifest('@artemis/gateway', {
        '@artemis/contracts': 'workspace:*',
        '@artemis/llm': 'workspace:*',
        '@artemis/mcp': 'workspace:*',
      }),
      'apps/gateway/src/bad.ts': "import { serve } from '@artemis/mcp/device-server';\nexport const bad = serve;\n",
    },
  },
  {
    name: 'rule-9',
    rule: 'rule-9',
    files: {
      'apps/gateway/src/bad-testing.ts': "import { FakeProvider } from '@artemis/llm/testing';\nexport const bad = FakeProvider;\n",
    },
  },
  {
    name: 'rule-10',
    rule: 'rule-10',
    files: {
      'scripts/bad-tooling.ts': "import { core } from '../packages/core/src/internal.ts';\nexport const bad = core;\n",
    },
  },
];

function selfTest() {
  const scratch = mkdtempSync(join(tmpdir(), 'check-boundaries-self-test-'));
  let failures = 0;
  try {
    for (const fixture of FIXTURES) {
      const root = join(scratch, fixture.name);
      const files = { ...baselineFixture(), ...fixture.files };
      for (const [path, contents] of Object.entries(files)) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
      }
      const { violations } = checkTree(root);
      if (fixture.rule === null) {
        if (violations.length === 0) {
          console.log(`PASS ${fixture.name}: clean fixture has no violations`);
        } else {
          failures += 1;
          console.log(`FAIL ${fixture.name}: clean fixture was flagged`);
          for (const v of violations) console.log(`  ${v.file}:${v.line} ${v.rule} ${v.message}`);
        }
        continue;
      }
      const fired = violations.some((v) => v.rule === fixture.rule);
      if (fired) {
        console.log(`PASS ${fixture.name}: caught the synthetic violation`);
      } else {
        failures += 1;
        console.log(`FAIL ${fixture.name}: the synthetic violation was not caught`);
        for (const v of violations) console.log(`  ${v.file}:${v.line} ${v.rule} ${v.message}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures === 0 ? 'self-test: all rules fire' : `self-test: ${failures} failure(s)`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest();
} else {
  const { violations, allowed, filesChecked, packages } = checkTree(ROOT);
  for (const v of violations) {
    console.log(`${v.file}:${v.line} ${v.rule} ${v.message}`);
  }
  console.log(
    `boundaries: ${violations.length} violation(s) in ${filesChecked} files across ${packages} packages` +
      (allowed > 0 ? ` (${allowed} allowlisted)` : '')
  );
  process.exitCode = violations.length > 0 ? 1 : 0;
}
