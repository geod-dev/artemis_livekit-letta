/**
 * Writes the `present` tool's schema, generated from the generative UI library
 * in `src/lib/present-library.ts`, to the files the agent-server registers the tool
 * from (`packages/contracts/generated/`). Run it after changing the library or
 * upgrading `@assistant-ui/react-generative-ui`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toJSONSchema } from 'zod';
import { presentLibrary, presentToolSchema } from '../src/lib/present-library.ts';

const generatedDirectory = new URL('../../../packages/contracts/generated/', import.meta.url);

/** The schema builder warns about props several components share, outside production; the generated files do not need the warnings. */
function withoutSharedPropWarnings<T>(run: () => T): T {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

const { schema, componentSchemas } = withoutSharedPropWarnings(() => {
  const library = presentLibrary(() => null);
  return {
    schema: presentToolSchema(library),
    componentSchemas: Object.fromEntries(
      Object.entries(library).map(([name, component]) => [name, toJSONSchema(component.properties)])
    ),
  };
});
const targets = [
  {
    label: 'schema',
    path: fileURLToPath(new URL('present-tool.json', generatedDirectory)),
    contents: `${JSON.stringify(schema, null, 2)}\n`,
  },
  {
    label: 'component protocol',
    path: fileURLToPath(new URL('present-components.json', generatedDirectory)),
    contents: `${JSON.stringify(componentSchemas, null, 2)}\n`,
  },
];

if (process.argv.includes('--check')) {
  for (const target of targets) {
    let current: string;
    try {
      current = readFileSync(target.path, 'utf8');
    } catch {
      console.error(`Generated ${target.label} is missing: ${target.path}`);
      process.exitCode = 1;
      continue;
    }
    if (current !== target.contents) {
      console.error(`Generated ${target.label} is out of date: ${target.path}`);
      process.exitCode = 1;
    } else {
      console.log(`Generated ${target.label} is up to date: ${target.path}`);
    }
  }
} else {
  mkdirSync(generatedDirectory, { recursive: true });
  for (const target of targets) {
    writeFileSync(target.path, target.contents);
    console.log(`Wrote ${target.path}`);
  }
}
