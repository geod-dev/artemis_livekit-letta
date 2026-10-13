import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  LogOutIcon,
  MoonIcon,
  PlugZapIcon,
  SunIcon,
} from 'lucide-react';
import { McpServers } from '@/components/settings/mcp-servers';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/shadcn/utils';
import { type Theme, applyTheme, getStoredTheme } from '@/lib/theme';

type SettingsSection = 'appearance' | 'mcp';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'mcp', label: 'MCP servers' },
];
const NAV_BUTTON =
  'hover:bg-muted focus-visible:ring-ring flex min-h-12 w-full shrink-0 items-center gap-3 rounded-xl px-4 py-3 text-start text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none';
const LAST_SECTION_KEY = 'settings-section';
const SECTION_ICONS = { appearance: SunIcon, mcp: PlugZapIcon };

function storedSection(): SettingsSection {
  try {
    const saved = window.localStorage.getItem(LAST_SECTION_KEY);
    return SECTIONS.find((section) => section.id === saved)?.id ?? 'appearance';
  } catch {
    return 'appearance';
  }
}

/**
 * App settings, over the chat rather than instead of it, so a live call keeps
 * running while they are open.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [section, setSection] = useState<SettingsSection>(storedSection);
  const [dashboard, setDashboard] = useState(true);
  const contentRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_SECTION_KEY, section);
    } catch {
      // Remembering the section is a convenience.
    }
  }, [section]);

  useEffect(() => {
    if (!open || !window.matchMedia('(max-width: 767px)').matches) return;
    if (dashboard) navigationRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    else contentRef.current?.focus();
  }, [dashboard, open]);

  const label = SECTIONS.find((s) => s.id === section)?.label;

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    applyTheme(nextTheme);
  }

  function signOut() {
    void fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location.reload());
  }

  function closeSettings() {
    setDashboard(true);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setDashboard(true);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="settings-page top-0 left-0 flex w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none duration-0 sm:max-w-none"
      >
        <DialogHeader className="border-border/70 shrink-0 border-b px-4 py-3 text-start sm:px-8">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
            <DialogTitle className="font-display text-xl font-extrabold">Settings</DialogTitle>
            <span
              aria-hidden="true"
              data-mascot-anchor="settings"
              className="block size-6 shrink-0"
            />
          </div>
        </DialogHeader>
        <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col md:flex-row">
          <nav
            ref={navigationRef}
            aria-label="Settings sections"
            className={cn(
              'border-border/70 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4 md:w-64 md:flex-none md:border-e',
              !dashboard && 'hidden md:flex'
            )}
          >
            <button type="button" onClick={closeSettings} className={NAV_BUTTON}>
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
              Back to app
            </button>
            {SECTIONS.map((item) => {
              const Icon = SECTION_ICONS[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSection(item.id);
                    setDashboard(false);
                  }}
                  aria-current={item.id === section ? 'page' : undefined}
                  className={cn(NAV_BUTTON, item.id === section && 'md:bg-muted')}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">{item.label}</span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0 md:hidden"
                  />
                </button>
              );
            })}
            <button
              type="button"
              onClick={signOut}
              title="Sign out"
              className={cn(NAV_BUTTON, 'mt-auto')}
            >
              <LogOutIcon aria-hidden="true" className="size-4 shrink-0" />
              <span>Sign out</span>
            </button>
          </nav>
          <section
            ref={contentRef}
            tabIndex={-1}
            aria-label={label}
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-y-auto p-4 outline-none sm:p-8 md:block',
              dashboard && 'hidden'
            )}
          >
            <button
              type="button"
              onClick={() => setDashboard(true)}
              className={cn(NAV_BUTTON, 'mb-6 md:hidden')}
            >
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
              All settings
            </button>
            {section === 'appearance' && (
              <div className="max-w-xl space-y-5">
                <div>
                  <h2 className="text-lg font-bold">Appearance</h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Choose how Artemis looks on this device.
                  </p>
                </div>
                <fieldset className="space-y-3">
                  <legend className="text-sm font-semibold">Color theme</legend>
                  <div className="grid grid-cols-2 gap-3">
                    {(['light', 'dark'] as const).map((option) => {
                      const Icon = option === 'dark' ? MoonIcon : SunIcon;
                      return (
                        <label
                          key={option}
                          className={cn(
                            'has-focus-visible:ring-ring relative flex cursor-pointer flex-col gap-3 rounded-2xl border-2 p-4 has-focus-visible:ring-2 has-focus-visible:ring-offset-2',
                            theme === option
                              ? 'border-primary bg-accent'
                              : 'border-border hover:bg-muted'
                          )}
                        >
                          <input
                            type="radio"
                            name="color-theme"
                            value={option}
                            checked={theme === option}
                            onChange={() => changeTheme(option)}
                            className="sr-only"
                          />
                          <div
                            aria-hidden="true"
                            className={cn(
                              'space-y-2 rounded-lg border p-3',
                              option === 'dark'
                                ? 'border-[#383541] bg-[#15141a]'
                                : 'border-[#e7e5ee] bg-white'
                            )}
                          >
                            <div
                              className={cn(
                                'h-2 w-1/2 rounded-full',
                                option === 'dark' ? 'bg-[#143d73]' : 'bg-[#0575f0]'
                              )}
                            />
                            <div
                              className={cn(
                                'h-2 w-3/4 rounded-full',
                                option === 'dark' ? 'bg-[#aaa6b7]' : 'bg-[#e7e5ee]'
                              )}
                            />
                            <div
                              className={cn(
                                'h-2 w-2/3 rounded-full',
                                option === 'dark' ? 'bg-[#383541]' : 'bg-[#e7e5ee]'
                              )}
                            />
                          </div>
                          <span className="flex items-center gap-2 text-sm font-semibold">
                            <Icon aria-hidden="true" className="size-4" />
                            {option === 'dark' ? 'Dark' : 'Light'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </div>
            )}
            {section === 'mcp' && <McpServers active={open} />}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
