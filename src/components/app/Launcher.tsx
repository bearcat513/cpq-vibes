import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Building2, CornerDownLeft, FileText, Loader2, Package, ScrollText, Search, type LucideIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { Portal } from "@/components/ui/portal";
import { StatusBadge, formatters } from "./common";
import { api } from "@/lib/api";
import { rankItems } from "@/lib/commands";
import type { Account, Product, ProposalTemplate, QuoteSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Something the launcher can do: go somewhere, start something, flip a switch. */
export type LauncherCommand = {
  id: string;
  label: string;
  /** The heading it is listed under while nothing has been typed. */
  group: string;
  Icon?: LucideIcon;
  /** More words it answers to: "invoice" finds Receivables. */
  keywords?: string;
  /** Its shortcut, printed beside it. */
  keys?: string[];
  /** Offered only once something is typed — one of a long family that would bury the list. */
  searchOnly?: boolean;
  run: () => void;
};

type Props = {
  commands: LauncherCommand[];
  accounts: Account[];
  products: Product[];
  templates: ProposalTemplate[];
  locale: string;
  onOpenQuote: (id: string) => void;
  onOpenCustomer: (id: string) => void;
  onOpenProduct: (id: string) => void;
  onOpenTemplate: (id: string) => void;
  onClose: () => void;
};

/** What one row of the list is, whatever produced it. */
type Entry = {
  key: string;
  group: string;
  label: string;
  detail?: string;
  Icon?: LucideIcon;
  keys?: string[];
  quote?: QuoteSummary;
  run: () => void;
};

/** How long typing has to pause before quotes are searched on the server. */
const SEARCH_DELAY_MS = 150;
const PER_GROUP = 5;

/**
 * The launcher: one box that goes anywhere and starts anything.
 *
 * Ctrl/⌘ K opens it from any screen. Typing filters the app's own commands —
 * every screen, every "New …", the switches in Settings — and searches the
 * records alongside them: quotes on the server, since there may be thousands,
 * and customers, products and templates from what is already loaded.
 *
 * It is a combobox over a listbox, written to the ARIA pattern: focus stays
 * in the box, the arrow keys move a highlight announced through
 * `aria-activedescendant`, Enter runs it and Escape closes. Ctrl N / Ctrl P
 * move too, for hands that live on the home row.
 *
 * Portalled to `<body>` like every overlay here, and marked `aria-modal` —
 * which is also what tells the app's single-key shortcuts to stand down while
 * it is open.
 */
export function Launcher({
  commands,
  accounts,
  products,
  templates,
  locale,
  onOpenQuote,
  onOpenCustomer,
  onOpenProduct,
  onOpenTemplate,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<QuoteSummary[]>([]);
  const [found, setFound] = useState<QuoteSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const optionRefs = useRef(new Map<number, HTMLElement>());

  // Focus goes back where it came from, the way a desktop palette leaves you.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  // With nothing typed, the newest quotes are the likeliest destination.
  useEffect(() => {
    let current = true;
    api
      .searchQuotes({ perPage: PER_GROUP })
      .then(page => current && setRecent(page.items))
      .catch(() => current && setRecent([]));
    return () => {
      current = false;
    };
  }, []);

  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < 2) {
      setFound([]);
      setSearching(false);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .searchQuotes({ q: trimmed, perPage: PER_GROUP })
        .then(page => current && setFound(page.items))
        .catch(() => current && setFound([]))
        .finally(() => current && setSearching(false));
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed]);

  const entries = useMemo<Entry[]>(() => {
    const fromCommand = (command: LauncherCommand, group = command.group): Entry => ({
      key: `cmd:${command.id}`,
      group,
      label: command.label,
      Icon: command.Icon,
      keys: command.keys,
      run: command.run,
    });
    const fromQuote = (group: string) => (quote: QuoteSummary): Entry => ({
      key: `quote:${quote.id}`,
      group,
      label: quote.name || quote.number,
      detail: [quote.number, quote.customer.name].filter(Boolean).join(" · "),
      Icon: ScrollText,
      quote,
      run: () => onOpenQuote(quote.id),
    });

    if (!trimmed) {
      // Grouped the way they were given, with the newest quotes after the
      // first group — "start something" first, "pick up where you were" next.
      const listed = commands.filter(command => !command.searchOnly);
      const groups: string[] = [];
      for (const command of listed) if (!groups.includes(command.group)) groups.push(command.group);
      const list: Entry[] = [];
      groups.forEach((group, index) => {
        list.push(...listed.filter(command => command.group === group).map(command => fromCommand(command)));
        if (index === 0) list.push(...recent.map(fromQuote("Recent quotes")));
      });
      return list;
    }

    const rankedCommands = rankItems(trimmed, commands, 8).map(command => fromCommand(command, "Commands"));
    const customers = rankItems(
      trimmed,
      accounts.map(account => ({
        account,
        label: account.name,
        keywords: [account.tags.join(" "), account.contacts.map(contact => `${contact.name} ${contact.email}`).join(" ")].join(" "),
      })),
      PER_GROUP,
    ).map(({ account }) => ({
      key: `account:${account.id}`,
      group: "Customers",
      label: account.name,
      detail: account.contacts.find(contact => contact.primary)?.name ?? "",
      Icon: Building2,
      run: () => onOpenCustomer(account.id),
    }));
    const catalogue = rankItems(
      trimmed,
      products.map(product => ({ product, label: product.name, keywords: `${product.sku} ${product.family}` })),
      PER_GROUP,
    ).map(({ product }) => ({
      key: `product:${product.id}`,
      group: "Products",
      label: product.name,
      detail: [product.sku, product.family].filter(Boolean).join(" · "),
      Icon: Package,
      run: () => onOpenProduct(product.id),
    }));
    const documents = rankItems(
      trimmed,
      templates.map(template => ({ template, label: template.name, keywords: `${template.kind} ${template.format}` })),
      PER_GROUP,
    ).map(({ template }) => ({
      key: `template:${template.id}`,
      group: "Templates",
      label: template.name,
      detail: `${template.kind === "invoice" ? "Invoice" : "Quote"} · ${template.format.toUpperCase()}`,
      Icon: FileText,
      run: () => onOpenTemplate(template.id),
    }));

    return [...rankedCommands, ...found.map(fromQuote("Quotes")), ...customers, ...catalogue, ...documents];
  }, [trimmed, commands, recent, found, accounts, products, templates, onOpenQuote, onOpenCustomer, onOpenProduct, onOpenTemplate]);

  // A new list starts at its top; a list that shrank keeps the highlight on it.
  useEffect(() => setActive(0), [trimmed]);
  const current = Math.min(active, Math.max(entries.length - 1, 0));

  useEffect(() => {
    optionRefs.current.get(current)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const step = (by: number) => {
      event.preventDefault();
      if (!entries.length) return;
      setActive((current + by + entries.length) % entries.length);
    };
    const ctrl = event.ctrlKey && !event.metaKey;
    if (event.key === "ArrowDown" || (ctrl && event.key === "n")) step(1);
    else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) step(-1);
    else if (event.key === "PageDown") step(Math.min(5, entries.length - 1 - current) || 0);
    else if (event.key === "PageUp") step(-Math.min(5, current) || 0);
    else if (event.key === "Enter") {
      event.preventDefault();
      run(entries[current]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      // Escape clears what was typed first, and closes on an empty box —
      // the way a desktop palette behaves.
      if (query) setQuery("");
      else onClose();
    }
  };

  const listId = "launcher-list";
  const optionId = (index: number) => `launcher-option-${index}`;

  return (
    <Portal>
      <div
        className="animate-in fade-in fixed inset-0 z-[60] flex items-start justify-center bg-[var(--scrim)] px-3 pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur-[1px] duration-150 sm:pt-[12vh]"
        onMouseDown={event => event.target === event.currentTarget && onClose()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Launcher"
          className="panel animate-in zoom-in-[0.98] slide-in-from-top-1 flex max-h-[calc(100dvh-1.5rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border shadow-2xl duration-150 sm:max-h-[70vh]"
        >
          <div className="seam flex items-center gap-2 border-b px-3">
            {searching ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Search className="size-4 shrink-0 text-muted-foreground" />
            )}
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={entries.length ? optionId(current) : undefined}
              aria-label="Search, or type a command"
              placeholder="Search quotes, customers, products — or type a command"
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
              className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={onClose}
              className="rounded-sm text-xs text-muted-foreground hover:text-foreground"
              aria-label="Close the launcher"
            >
              <Kbd keys={["Escape"]} />
            </button>
          </div>

          <div id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {entries.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                {searching ? "Searching…" : `Nothing matches “${trimmed}”.`}
              </p>
            ) : (
              entries.map((entry, index) => {
                const heading = index === 0 || entries[index - 1]!.group !== entry.group;
                const selected = index === current;
                const Icon = entry.Icon;
                return (
                  <div key={entry.key} role="presentation">
                    {heading && (
                      <p role="presentation" className="px-2.5 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        {entry.group}
                      </p>
                    )}
                    <div
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      ref={element => {
                        if (element) optionRefs.current.set(index, element);
                        else optionRefs.current.delete(index);
                      }}
                      onMouseMove={() => index !== current && setActive(index)}
                      onClick={() => run(entry)}
                      className={cn(
                        "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm select-none",
                        selected ? "bg-accent text-accent-foreground" : "text-foreground",
                      )}
                    >
                      {Icon && <Icon className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{entry.label}</span>
                        {entry.detail && <span className="block truncate text-xs text-muted-foreground">{entry.detail}</span>}
                      </span>
                      {entry.quote && <QuoteFacts quote={entry.quote} locale={locale} />}
                      {entry.keys && <Kbd keys={entry.keys} className="hidden sm:inline-flex" />}
                      {selected && <CornerDownLeft className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" />}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="hidden items-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground sm:flex">
            <span className="flex items-center gap-1">
              <Kbd keys={["ArrowUp"]} />
              <Kbd keys={["ArrowDown"]} /> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd keys={["Enter"]} /> open
            </span>
            <span className="flex items-center gap-1">
              <Kbd keys={["Escape"]} /> close
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd keys={["mod+k"]} /> opens this anywhere
            </span>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function QuoteFacts({ quote, locale }: { quote: QuoteSummary; locale: string }) {
  const format = formatters(quote.currency, locale);
  return (
    <span className="hidden shrink-0 items-center gap-2 sm:flex">
      <span className="text-xs text-muted-foreground tabular-nums">{format.money(quote.totals?.grandTotal ?? 0)}</span>
      <StatusBadge status={quote.status} />
    </span>
  );
}
