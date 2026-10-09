/**
 * Writes the `present` tool's schema, generated from the app's generative UI
 * library, to the file the backend registers with Letta. Run it after
 * changing the library or upgrading `@assistant-ui/react-generative-ui`.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { presentLibrary, presentToolSchema } from '../src/lib/generative-ui.ts';

const target = fileURLToPath(
  new URL('../../backend/src/assistant/present-tool.json', import.meta.url)
);
// Without the schema's shared-prop warnings (see `presentToolSchema`).
process.env.NODE_ENV = 'production';
const schema = presentToolSchema(presentLibrary(() => null));
writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
console.log(`Wrote ${target}`);
