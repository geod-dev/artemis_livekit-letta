/**
 * Writes the `present` tool's schema, generated from the app's generative UI
 * library, to the file the backend registers with Letta. Run it after
 * changing the library or upgrading `@assistant-ui/react-generative-ui`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toJSONSchema } from 'zod';
import { presentLibrary, presentToolSchema } from '../src/lib/generative-ui.ts';

const generatedDirectory = new URL('../../shared/generated/', import.meta.url);
const targets = [
  {
    label: 'schema',
    path: fileURLToPath(new URL('present-tool.json', generatedDirectory)),
    contents: '',
  },
  {
    label: 'component protocol',
    path: fileURLToPath(new URL('present-components.json', generatedDirectory)),
    contents: '',
  },
];
// Without the schema's shared-prop warnings (see `presentToolSchema`).
process.env.NODE_ENV = 'production';
const schema = presentToolSchema(presentLibrary(() => null));
targets[0].contents = `${JSON.stringify(schema, null, 2)}\n`;
const library = presentLibrary(() => null);
const componentSchemas = Object.fromEntries(
  Object.entries(library).map(([name, component]) => [name, toJSONSchema(component.properties)])
);
targets[1].contents = `${JSON.stringify(componentSchemas, null, 2)}\n`;

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
