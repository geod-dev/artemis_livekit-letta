import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rehypeCitations, withoutCitations } from './citations.ts';

/** The element at `index`; a fixture that lacks it fails the test here. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no element at index ${index}`);
  return item;
}

const text = (value: string) => ({ type: 'text', value });
const link = (href: string, label: string) => ({
  type: 'element',
  tagName: 'a',
  properties: { href },
  children: [text(label)],
});
const paragraph = (...children: object[]) => ({
  type: 'root',
  children: [{ type: 'element', tagName: 'p', properties: {}, children }],
});
const run = (tree: ReturnType<typeof paragraph>) => {
  rehypeCitations()(tree as never);
  return at(tree.children, 0).children as {
    value?: string;
    properties?: Record<string, unknown>;
  }[];
};

test('marks a link alone in parentheses as a citation and drops the parentheses', () => {
  const nodes = run(
    paragraph(text('Released in March ('), link('https://a.com', 'The Verge'), text(').'))
  );
  assert.equal(at(nodes, 0).value, 'Released in March ');
  assert.equal(at(nodes, 1).properties?.dataCitation, 'true');
  assert.equal(at(nodes, 2).value, '.');
});

test('marks each citation of a row of citations', () => {
  const nodes = run(
    paragraph(
      text('Done ('),
      link('https://a.com', 'A'),
      text(') ('),
      link('https://b.com', 'B'),
      text(')')
    )
  );
  assert.equal(at(nodes, 1).properties?.dataCitation, 'true');
  assert.equal(at(nodes, 3).properties?.dataCitation, 'true');
  assert.equal(at(nodes, 2).value, ' ');
});

test('marks the links of one parenthesis separated by commas', () => {
  const nodes = run(
    paragraph(
      text('Done ('),
      link('https://a.com', 'A'),
      text(', '),
      link('https://b.com', 'B'),
      text(').')
    )
  );
  assert.equal(at(nodes, 0).value, 'Done ');
  assert.equal(at(nodes, 1).properties?.dataCitation, 'true');
  assert.equal(at(nodes, 2).value, ' ');
  assert.equal(at(nodes, 3).properties?.dataCitation, 'true');
  assert.equal(at(nodes, 4).value, '.');
});

test('leaves a parenthesis that mixes links and text alone', () => {
  const nodes = run(
    paragraph(
      text('('),
      link('https://a.com', 'A'),
      text(' and '),
      link('https://b.com', 'B'),
      text(')')
    )
  );
  assert.equal(at(nodes, 1).properties?.dataCitation, undefined);
  assert.equal(at(nodes, 3).properties?.dataCitation, undefined);
});

test('leaves links in prose, or sharing their parentheses with text, alone', () => {
  const prose = run(paragraph(text('See '), link('https://a.com', 'the repo'), text(' now.')));
  assert.equal(at(prose, 1).properties?.dataCitation, undefined);
  const shared = run(paragraph(text('(see '), link('https://a.com', 'A'), text(')')));
  assert.equal(at(shared, 1).properties?.dataCitation, undefined);
  const local = run(paragraph(text('('), link('files/a.pdf', 'a.pdf'), text(')')));
  assert.equal(at(local, 1).properties?.dataCitation, undefined);
});

test('removes citations from markdown, keeping other links', () => {
  assert.equal(
    withoutCitations('See [repo](https://r.dev) ([Doc](https://d.dev)).'),
    'See [repo](https://r.dev) .'
  );
  assert.equal(withoutCitations('Done ([A](https://a.dev), [B](https://b.dev)).'), 'Done .');
});
