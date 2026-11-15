import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { CREATE_ORDER, CREATES, VIEWS, keysFor, type ShortcutId, type View } from "./navigation";

type Props = {
  /** Whether the single-key shortcuts are on — they can be switched off in Settings. */
  enabled: boolean;
  onEnable: () => void;
  onClose: () => void;
};

const GENERAL: { id: ShortcutId; label: string }[] = [
  { id: "launcher", label: "Open the launcher" },
  { id: "search", label: "Search (opens the launcher)" },
  { id: "toggleNav", label: "Collapse or expand the navigation" },
  { id: "help", label: "This list" },
];

/**
 * Every shortcut, generated from the same table the key handler reads — so
 * the list cannot advertise a key that does nothing.
 */
export function ShortcutsDialog({ enabled, onEnable, onClose }: Props) {
  const views = Object.keys(VIEWS) as View[];

  return (
    <Dialog
      title="Keyboard shortcuts"
      description="A letter, then a letter: G Q goes to Quotes. Shortcuts wait while you are typing in a field."
      onClose={onClose}
      className="max-w-2xl"
    >
      {!enabled && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border bg-hazard/10 px-3 py-2 text-xs text-hazard">
          Single-key shortcuts are switched off for this account. Ctrl/⌘ K still opens the launcher.
          <Button size="sm" variant="outline" onClick={onEnable}>
            Switch them on
          </Button>
        </div>
      )}

      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <Group title="General" rows={GENERAL.map(row => ({ label: row.label, keys: keysFor(row.id) }))} />
        <Group
          title="Start something"
          rows={CREATE_ORDER.map(kind => ({ label: CREATES[kind].label, keys: keysFor(`new:${kind}`) }))}
        />
        <Group
          title="Go to"
          className="sm:col-span-2"
          columns
          rows={views.map(view => ({ label: VIEWS[view].label, keys: keysFor(`go:${view}`) }))}
        />
        <Group
          title="In the launcher"
          rows={[
            { label: "Move", keys: ["ArrowUp", "ArrowDown"] },
            { label: "Open the highlighted result", keys: ["Enter"] },
            { label: "Clear, then close", keys: ["Escape"] },
          ]}
        />
      </div>
    </Dialog>
  );
}

function Group({
  title,
  rows,
  className,
  columns,
}: {
  title: string;
  rows: { label: string; keys: string[] }[];
  className?: string;
  columns?: boolean;
}) {
  return (
    <section className={className}>
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <dl className={columns ? "sm:columns-2 sm:gap-x-8" : undefined}>
        {rows.map(row => (
          <div key={row.label} className="flex break-inside-avoid items-center justify-between gap-3 border-b border-dashed py-1.5 text-sm last:border-b-0">
            <dt>{row.label}</dt>
            <dd>
              <Kbd keys={row.keys} label />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
