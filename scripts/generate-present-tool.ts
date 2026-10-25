/**
 * Writes the `present` tool's schema and the component protocol, generated from the
 * generative UI library in apps/web/src/lib/present-library.ts, to the files the
 * agent-server registers the tool from (`packages/contracts/generated/`). The component
 * names the library must implement are declared in packages/contracts/src/present-components.ts;
 * the run fails when the two differ. Run it after changing either, or after upgrading
 * `@assistant-ui/react-generative-ui`. `--check` compares instead of writing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRESENT_COMPONENT_NAMES } from '@artemis/contracts/present-components';
import { toJSONSchema } from 'zod';
import { presentLibrary, presentToolSchema } from '../apps/web/src/lib/present-library.ts';

const generatedDirectory = new URL('../packages/contracts/generated/', import.meta.url);

/** The JSON Schema of each component's props, keyed by component name (the generated component protocol). */
function presentComponentSchemas(library: ReturnType<typeof presentLibrary>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(library).map(([name, component]) => [name, toJSONSchema(component.properties)])
  );
}

const library = presentLibrary(() => null);
const libraryNames = Object.keys(library);
const declaredNames: readonly string[] = PRESENT_COMPONENT_NAMES;
if (
  libraryNames.length !== declaredNames.length ||
  libraryNames.some((name, index) => name !== declaredNames[index])
) {
  console.error(
    `The present library must define ${declaredNames.join(', ')} in that order; it defines ${libraryNames.join(', ')}.`
  );
  process.exit(1);
}

const targets = [
  {
    label: 'schema',
    path: fileURLToPath(new URL('present-tool.json', generatedDirectory)),
    contents: `${JSON.stringify(presentToolSchema(library, { warnings: false }), null, 2)}\n`,
  },
  {
    label: 'component protocol',
    path: fileURLToPath(new URL('present-components.json', generatedDirectory)),
    contents: `${JSON.stringify(presentComponentSchemas(library), null, 2)}\n`,
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
