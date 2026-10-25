import { type CSSProperties, useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { TEXT_EFFORTS, type TextEffort } from '@artemis/contracts/chat-types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useChatThread } from '@/hooks/use-chat-thread';

const EFFORT_VALUES: readonly TextEffort[] = TEXT_EFFORTS;
const EFFORT_LABELS: Record<TextEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** Sparkle particles per level: more effort, more of them. */
const PARTICLES_PER_LEVEL = 2;
const BASE_PARTICLES = 14;
const PARTICLE_POOL = BASE_PARTICLES + PARTICLES_PER_LEVEL * (EFFORT_VALUES.length - 1);

/** The composer's response-effort control: a popover on desktop, a dialog on phones. */
export function ComposerEffortControl() {
  const { effort, setEffort } = useChatThread();
  const index = EFFORT_VALUES.indexOf(effort);
  const particleCount = BASE_PARTICLES + PARTICLES_PER_LEVEL * index;
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [particleStyles] = useState(() =>
    Array.from({ length: PARTICLE_POOL }, () => {
      const random = (min: number, max: number) => min + Math.random() * (max - min);
      return {
        size: random(1.5, 4.5),
        yStart: random(-12, 12),
        yEnd: random(-12, 12),
        speedFactor: random(0.75, 1.25),
        phase: random(-1, 0),
        opacity: random(0.35, 0.95),
      };
    })
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => {
      setIsMobile(query.matches);
      setMobileOpen(false);
      setDesktopOpen(false);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const pickerContent = (
    <>
      <p className="mb-3 text-center text-sm font-bold">{EFFORT_LABELS[effort]}</p>
      <div
        className="effort-slider-wrap relative flex h-[68px] items-center"
        style={
          {
            '--effort-progress': `${(index / (EFFORT_VALUES.length - 1)) * 100}%`,
          } as CSSProperties
        }
      >
        <div className="effort-slider-track" aria-hidden="true">
          <span className="effort-slider-fill">
            {particleStyles.slice(0, particleCount).map((style, particleIndex) => (
              <i
                key={particleIndex}
                className="effort-slider-particle"
                style={
                  {
                    '--particle-size': `${style.size}px`,
                    '--particle-y-start': `${style.yStart}px`,
                    '--particle-y-end': `${style.yEnd}px`,
                    '--particle-duration': `${950 * style.speedFactor}ms`,
                    '--particle-delay': `${950 * style.phase}ms`,
                    '--particle-opacity': style.opacity,
                  } as CSSProperties
                }
              />
            ))}
          </span>
          <span className="effort-slider-thumb" />
        </div>
        <input
          type="range"
          min={0}
          max={EFFORT_VALUES.length - 1}
          step={1}
          value={index}
          onChange={(event) => {
            const next = EFFORT_VALUES[Number(event.target.value)];
            if (next) setEffort(next);
          }}
          aria-label="Text response effort"
          aria-valuetext={EFFORT_LABELS[effort]}
          className="effort-slider absolute inset-0 z-10 h-full w-full cursor-pointer"
        />
      </div>
    </>
  );

  return (
    <>
      <Popover.Root open={!isMobile && desktopOpen} onOpenChange={setDesktopOpen}>
        <Popover.Anchor asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Response effort: ${EFFORT_LABELS[effort]}`}
            aria-haspopup="dialog"
            aria-expanded={isMobile ? mobileOpen : desktopOpen}
            onClick={() => {
              if (isMobile) setMobileOpen(true);
              else setDesktopOpen((open) => !open);
            }}
            className="aui-composer-effort-trigger text-muted-foreground hover:bg-muted hover:text-foreground h-7 rounded-full bg-transparent px-2.5 text-xs font-semibold"
          >
            {EFFORT_LABELS[effort]}
          </Button>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={10}
            className="surface-panel effort-popover text-popover-foreground z-50 w-72 p-3 outline-none"
          >
            {pickerContent}
            <Popover.Arrow className="effort-popover-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent
          showCloseButton={false}
          aria-label="Response effort"
          className="effort-mobile-dialog gap-2 p-5"
        >
          {pickerContent}
        </DialogContent>
      </Dialog>
    </>
  );
}
