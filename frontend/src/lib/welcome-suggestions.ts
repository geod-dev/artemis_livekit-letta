/** One suggestion from each area keeps the starting points varied. */
type WelcomeSuggestion = {
  label: string;
  icon: 'idea' | 'write' | 'explore' | 'compare' | 'file' | 'plan' | 'code';
  prompt: string;
};

const GROUPS: readonly (readonly WelcomeSuggestion[])[] = [
  [
    {
      label: 'Untangle an idea',
      icon: 'idea',
      prompt: 'Help me think through an idea. Ask me a few questions to get started.',
    },
    {
      label: 'Find the right words',
      icon: 'write',
      prompt:
        'Help me write something. First ask who it’s for, what I want to say, and the tone I’m after.',
    },
    {
      label: 'Brainstorm names',
      icon: 'idea',
      prompt:
        'Help me find a distinctive name for something. Ask me about the project and the feeling it should convey.',
    },
    {
      label: 'Shape a story',
      icon: 'write',
      prompt:
        'Help me develop a story. Ask me about the seed of the idea, then explore a few directions with me.',
    },
  ],
  [
    {
      label: 'Compare my options',
      icon: 'compare',
      prompt:
        'Help me make a decision. Ask me about the options and what matters most, then lay out the tradeoffs.',
    },
    {
      label: 'Explain something',
      icon: 'explore',
      prompt:
        'Help me understand a topic. Ask what I want to learn and what I already know, then explain it with concrete examples.',
    },
    {
      label: 'Research a question',
      icon: 'explore',
      prompt:
        'Help me research a question. Ask what I’m investigating, then find reliable sources and summarize what they establish.',
    },
    {
      label: 'Read a file with me',
      icon: 'file',
      prompt:
        'I’ll attach a file. Help me find the key points, open questions, and anything that needs my attention.',
    },
  ],
  [
    {
      label: 'Make a plan',
      icon: 'plan',
      prompt:
        'Help me turn a goal into a practical plan. Ask me what I have in mind and what constraints I’m working with.',
    },
    {
      label: 'Fix some code',
      icon: 'code',
      prompt:
        'Help me troubleshoot some code. Ask me for the code, what I expected, and what happened instead.',
    },
    {
      label: 'Organize my notes',
      icon: 'file',
      prompt:
        'I’ll share some rough notes. Help me turn them into a clear structure with decisions, open questions, and next steps.',
    },
    {
      label: 'Learn a new skill',
      icon: 'plan',
      prompt:
        'Help me learn a new skill. Ask about my starting point and available time, then suggest a small hands-on first project.',
    },
  ],
];

export function pickWelcomeSuggestions(
  previous: readonly WelcomeSuggestion[] = []
): WelcomeSuggestion[] {
  return GROUPS.map((group, index) => {
    const choices = group.filter((item) => item.label !== previous[index]?.label);
    return choices[Math.floor(Math.random() * choices.length)];
  });
}
