/** The big hello on the new-chat screen: one short line, picked at random. */

type Greeting = string | ((name: string) => string);

const ANYTIME: Greeting[] = [
  'What are we working on?',
  'Ready to chat!',
  'Sup?',
  (name) => `${name}, right here.`,
  'What’s the plan?',
  'Hit me.',
  'Got something for me?',
  'Let’s get stuff done.',
  'Where were we?',
  'What’s on your mind?',
  'Brain’s warmed up.',
  'Okay, what now?',
  'Talk to me.',
  'Big idea or small fix?',
  'Let’s untangle it.',
  'I’m all ears.',
  'Shoot.',
  'What’s the mission?',
  'Need a second brain?',
  'One thing at a time. What first?',
];

/** Lines that only make sense at some hours, keyed by [from, to) local hour. */
const TIMED: { from: number; to: number; lines: Greeting[] }[] = [
  {
    from: 5,
    to: 12,
    lines: ['Good morning!', 'Coffee first, then world domination?', 'Early start, nice.'],
  },
  { from: 12, to: 18, lines: ['Good afternoon!', 'Post-lunch mode?'] },
  { from: 18, to: 22, lines: ['Good evening!', 'Winding down or ramping up?'] },
  { from: 22, to: 29, lines: ['Working that late?', 'Night owl mode.', 'Can’t sleep either?'] },
];

/** Every greeting that fits this hour (0–23). */
export function greetingsFor(hour: number, name: string): string[] {
  const timed = TIMED.filter(
    ({ from, to }) => (hour >= from && hour < to) || hour + 24 < to
  ).flatMap((slot) => slot.lines);
  return [...ANYTIME, ...timed].map((g) => (typeof g === 'string' ? g : g(name)));
}

export function pickGreeting(name: string, now = new Date(), random = Math.random): string {
  const pool = greetingsFor(now.getHours(), name);
  return pool[Math.floor(random() * pool.length)];
}
