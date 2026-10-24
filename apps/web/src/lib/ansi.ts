/**
 * ANSI escape handling for terminal output: a line becomes styled segments (SGR colours,
 * bold and dim). Other control sequences (cursor moves, OSC titles) are dropped. Pure, so
 * the terminal component only renders the segments.
 */

export type AnsiColor =
  30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 90 | 91 | 92 | 93 | 94 | 95 | 96 | 97;

export type AnsiSegment = {
  text: string;
  color?: AnsiColor | undefined;
  bold: boolean;
  dim: boolean;
};

const ANSI_COLORS = new Set<AnsiColor>([
  30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97,
]);

const findCsiEnd = (line: string, start: number) => {
  for (let index = start; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return line.length;
};

const findStringEnd = (line: string, start: number, bell: boolean) => {
  for (let index = start; index < line.length; index += 1) {
    if (bell && line[index] === '\u0007') return index + 1;
    if (line[index] === '\u001b' && line[index + 1] === '\\') {
      return index + 2;
    }
  }
  return line.length;
};

const applySgr = (value: string, state: Omit<AnsiSegment, 'text'>) => {
  const parts = value.split(';');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const code = part === '' ? 0 : Number(part);
    if (code === 38 || code === 48) {
      index += parts[index + 1] === '2' ? 4 : parts[index + 1] === '5' ? 2 : 1;
    } else if (code === 0) {
      state.color = undefined;
      state.bold = false;
      state.dim = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 2) {
      state.dim = true;
    } else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 39) {
      state.color = undefined;
    } else if (ANSI_COLORS.has(code as AnsiColor)) {
      state.color = code as AnsiColor;
    }
  }
};

export function parseAnsi(line: string): AnsiSegment[] {
  const state: Omit<AnsiSegment, 'text'> = {
    color: undefined,
    bold: false,
    dim: false,
  };
  const segments: AnsiSegment[] = [];
  let index = 0;

  const append = (text: string) => {
    if (text === '') return;
    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.color === state.color &&
      previous.bold === state.bold &&
      previous.dim === state.dim
    ) {
      previous.text += text;
      return;
    }
    segments.push({ text, ...state });
  };

  while (index < line.length) {
    const escape = line.indexOf('\u001b', index);
    const c1Offset = line.slice(index).search(/[\u009b\u009d]/);
    const c1 = c1Offset === -1 ? -1 : index + c1Offset;
    const next = escape === -1 ? c1 : c1 === -1 ? escape : Math.min(escape, c1);

    if (next === -1) {
      append(line.slice(index));
      break;
    }

    append(line.slice(index, next));
    const csi = line[next] === '\u009b' || line[next + 1] === '[';
    const osc = line[next] === '\u009d' || line[next + 1] === ']';

    if (csi) {
      const start = next + (line[next] === '\u001b' ? 2 : 1);
      const end = findCsiEnd(line, start);
      if (end === line.length) break;
      if (line[end] === 'm') applySgr(line.slice(start, end), state);
      index = end + 1;
    } else if (osc) {
      index = findStringEnd(line, next + (line[next] === '\u001b' ? 2 : 1), true);
    } else if (line[next] === '\u001b' && ['P', '^', '_'].includes(line[next + 1] ?? '')) {
      index = findStringEnd(line, next + 2, false);
    } else {
      index =
        line[next] === '\u001b' &&
        ['(', ')', '*', '+', '-', '.', '/'].includes(line[next + 1] ?? '')
          ? next + 3
          : next + 2;
    }
  }

  return segments;
}
