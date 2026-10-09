import { useEffect, useState } from 'react';
import { McpServers } from '@/components/settings/mcp-servers';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/shadcn/utils';

type SettingsSection = 'mcp';

/** The sections, grouped as the menu shows them. */
const SECTION_GROUPS: { label: string; sections: { id: SettingsSection; label: string }[] }[] = [
  { label: 'Tools & integrations', sections: [{ id: 'mcp', label: 'MCP servers' }] },
];
const SECTIONS = SECTION_GROUPS.flatMap((group) => group.sections);
const LAST_SECTION_KEY = 'settings-section';

function storedSection(): SettingsSection {
  try {
    const saved = window.localStorage.getItem(LAST_SECTION_KEY);
    return SECTIONS.find((section) => section.id === saved)?.id ?? 'mcp';
  } catch {
    return 'mcp';
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

  useEffect(() => {
    try {
      window.localStorage.setItem(LAST_SECTION_KEY, section);
    } catch {
      // Remembering the section is a convenience.
    }
  }, [section]);

  const label = SECTIONS.find((s) => s.id === section)?.label;

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
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <section aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-6">
            {section === 'mcp' && <McpServers active={open} />}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
