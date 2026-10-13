import { useEffect, useState } from 'react';
import { LogOutIcon, MoonIcon, PlugZapIcon, SunIcon } from 'lucide-react';
import { McpServers } from '@/components/settings/mcp-servers';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { applyTheme, getStoredTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/shadcn/utils';

type SettingsSection = 'appearance' | 'mcp';

/** The sections, grouped as the menu shows them. */
const SECTION_GROUPS: { label: string; sections: { id: SettingsSection; label: string }[] }[] = [
  { label: 'Preferences', sections: [{ id: 'appearance', label: 'Appearance' }] },
  { label: 'Tools & integrations', sections: [{ id: 'mcp', label: 'MCP servers' }] },
];
const SECTIONS = SECTION_GROUPS.flatMap((group) => group.sections);
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
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_SECTION_KEY, section);
    } catch {
      // Remembering the section is a convenience.
    }
  }, [section]);

  const label = SECTIONS.find((s) => s.id === section)?.label;

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    applyTheme(nextTheme);
  }

  function signOut() {
    void fetch('/api/auth/logout', { method: 'POST' }).then(() => window.location.reload());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(85vh,44rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-border/70 border-b px-6 py-4 text-start">
          <DialogTitle className="font-display text-xl font-extrabold">Settings</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label="Settings sections"
            className="border-border/70 flex shrink-0 gap-4 overflow-x-auto border-b p-3 md:w-56 md:flex-col md:border-e md:border-b-0"
          >
            {SECTION_GROUPS.map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <p className="text-muted-foreground px-3 text-xs font-semibold">{group.label}</p>
                {group.sections.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    aria-current={item.id === section ? 'page' : undefined}
                    className={cn(
                      'hover:bg-muted rounded-xl px-3 py-2 text-start text-sm whitespace-nowrap',
                      item.id === section && 'bg-muted font-semibold'
                    )}
                  >
                    {(() => {
                      const Icon = SECTION_ICONS[item.id];
                      return <Icon aria-hidden="true" className="size-4 shrink-0" />;
                    })()}
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
            <button
              type="button"
              onClick={signOut}
              className="text-muted-foreground hover:bg-muted hover:text-foreground mt-auto flex items-center gap-2 rounded-xl border-t px-3 py-3 text-start text-sm md:mt-4"
            >
              <LogOutIcon aria-hidden="true" className="size-4 shrink-0" />
              Sign out
            </button>
          </nav>
          <section aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-6">
            {section === 'appearance' && (
              <div className="max-w-xl space-y-5">
                <div>
                  <h2 className="text-lg font-bold">Appearance</h2>
                  <p className="text-muted-foreground mt-1 text-sm">Choose how Artemis looks on this device.</p>
                </div>
                <div className="border-border flex items-center justify-between gap-4 rounded-2xl border p-4">
                  <div className="flex items-center gap-3">
                    {theme === 'dark' ? (
                      <MoonIcon aria-hidden="true" className="text-muted-foreground size-5" />
                    ) : (
                      <SunIcon aria-hidden="true" className="text-muted-foreground size-5" />
                    )}
                    <div>
                      <p className="text-sm font-semibold">Dark mode</p>
                      <p className="text-muted-foreground text-sm">Use a darker color palette.</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={theme === 'dark'}
                    aria-label="Dark mode"
                    onClick={() => changeTheme(theme === 'dark' ? 'light' : 'dark')}
                    className={cn(
                      'focus-visible:ring-ring relative h-7 w-12 shrink-0 rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none',
                      theme === 'dark' ? 'bg-primary' : 'bg-muted-foreground/35'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-1 size-5 rounded-full bg-white shadow transition-transform',
                        theme === 'dark' ? 'translate-x-6' : 'translate-x-1'
                      )}
                    />
                  </button>
                </div>
              </div>
            )}
            {section === 'mcp' && <McpServers active={open} />}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
