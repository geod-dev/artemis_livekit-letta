import type { SVGProps } from 'react';

/** Shared Artemis mark for the app header and animated chat mascot. */
export function MascotMark({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-2 -2 104 104" {...props}>
      <circle cx="50" cy="50" r="43.75" fill="none" stroke="currentColor" strokeWidth="12.5" />
      {children ?? (
        <g fill="currentColor">
          <rect x="29" y="32.5" width="16" height="35" rx="8" />
          <rect x="55" y="32.5" width="16" height="35" rx="8" />
        </g>
      )}
    </svg>
  );
}
