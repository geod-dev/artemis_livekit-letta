/** Map the three smart slider positions to the model's supported SDK tiers. */
export function modelEffort(handle: string, effort: string): string {
  if (/(?:^|\/)glm-5\.3(?:-flash)?$/i.test(handle)) {
    return (
      ({ low: 'low', medium: 'high', high: 'xhigh' } as Record<string, string>)[effort] ?? effort
    );
  }
  return effort;
}
