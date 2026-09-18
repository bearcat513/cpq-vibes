import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  /** A second line under the label — a product's name beside its SKU. */
  hint?: string;
  /** A short tag on the right: "bundle", "inactive". */
  badge?: string;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /**
   * Lets a value that is not in the list stand.
   *
   * On for the catalogue references, because the formats behind them allow a
   * dangling one: a price book may legitimately price a SKU this workspace has
   * not created yet, and the importer warns about that rather than refusing
   * it. Turning it off here would make the UI stricter than the file format.
   */
  allowCustom?: boolean;
  /** The label for the "no value" row. Omitted means the field is required. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

/**
 * A searchable dropdown for a field that names another record.
 *
 * Anywhere this app asks for a SKU, a family or an approver, it is asking
 * which *existing thing* you mean — and a bare text box answers that question
 * with a typo. A SKU typed into a bundle that does not match a product does
 * not fail; the component is quietly skipped when the bundle is expanded, so
 * the quote comes out missing a line and nothing says why. Offering the real
 * list is the fix.
 *
 * ## Why it portals
 *
 * Every form in this app lives in a side panel that scrolls (`ui/sheet.tsx`).
 * A dropdown positioned inside that panel gets clipped by its `overflow-y-auto`
 * the moment the field is near the bottom — which is exactly where the
 * repeated rows (bundle components, price book entries) are. So the list is
 * portalled to `document.body` and positioned against the trigger's rectangle,
 * recomputed on scroll and resize.
 *
 * Escape is handled on the capture phase so it closes this list rather than
 * the panel behind it.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  allowCustom,
  emptyLabel,
  disabled,
  className,
  "aria-label": ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; above: boolean } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const selected = options.find(option => option.value === value);
  /** A stored value the list does not have — still shown, never hidden. */
  const isCustom = Boolean(value) && !selected;

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = needle
      ? options.filter(option =>
          [option.value, option.label, option.hint].some(part => part?.toLowerCase().includes(needle)),
        )
      : options;

    const list: (ComboboxOption & { custom?: boolean })[] = [];
    if (emptyLabel !== undefined && !needle) list.push({ value: "", label: emptyLabel });
    list.push(...matching);

    // Offer the typed text when it is not already an option.
    const typed = search.trim();
    if (allowCustom && typed && !options.some(option => option.value.toLowerCase() === typed.toLowerCase())) {
      list.push({ value: typed, label: `Use “${typed}”`, custom: true });
    }

    return list;
  }, [options, search, allowCustom, emptyLabel]);

  /* ------------------------------ positioning ----------------------------- */

  const place = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const box = trigger.getBoundingClientRect();
    const below = window.innerHeight - box.bottom;
    // Flip above when there is more room there — the last row of a long form
    // is the common case and it sits at the bottom of the panel.
    const above = below < 260 && box.top > below;

    setRect({
      top: above ? box.top : box.bottom,
      left: box.left,
      width: box.width,
      above,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();

    // Capture, so the panel's own scrolling moves the list with the field.
    const onScroll = () => place();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setSearch("");
    setActive(0);
  }, [open]);

  /* -------------------------------- closing ------------------------------- */

  useEffect(() => {
    if (!open) return;

    /**
     * A click outside dismisses the list and goes no further.
     *
     * Swallowing it matters because these forms live in a panel whose backdrop
     * closes the panel: without this, clicking away from an open dropdown
     * would shut the whole form and lose the edit. Capture phase, plus a
     * one-shot on the `click` that follows, because dismissing on `pointerdown`
     * alone still lets the later `click` reach the backdrop.
     */
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;

      event.stopPropagation();
      setOpen(false);

      const swallowClick = (click: MouseEvent) => {
        click.stopPropagation();
        document.removeEventListener("click", swallowClick, true);
      };
      document.addEventListener("click", swallowClick, true);
    };

    // Capture phase: Escape belongs to this list first, and the sheet behind
    // it listens on document too.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  /* -------------------------------- choosing ------------------------------ */

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(current => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return Math.max(0, Math.min(rows.length - 1, next));
      });
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[active];
      if (row) choose(row.value);
      return;
    }

    if (event.key === "Tab") setOpen(false);
  };

  // Keep the highlighted row on screen while arrowing through a long list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /* -------------------------------- render -------------------------------- */

  const label = selected?.label ?? (isCustom ? value : "");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "Enter") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "border-input flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
          "dark:bg-input/30",
          className,
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate text-left", !label && "text-muted-foreground")}>
          {label || placeholder}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            style={{
              position: "fixed",
              left: rect.left,
              width: Math.max(rect.width, 220),
              ...(rect.above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.top + 4 }),
            }}
            className="z-[60] overflow-hidden rounded-md border bg-background shadow-lg"
          >
            <div className="relative border-b">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                value={search}
                onChange={event => {
                  setSearch(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
                placeholder="Search"
                aria-label="Search"
                className="w-full bg-transparent py-2 pr-2 pl-8 text-sm outline-none"
              />
            </div>

            <div className="max-h-60 overflow-y-auto py-1">
              {rows.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {options.length ? "Nothing matches that." : "Nothing to choose from yet."}
                </p>
              ) : (
                rows.map((row, index) => {
                  const chosen = row.value === value && !row.custom;
                  return (
                    <button
                      key={`${row.value}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      data-index={index}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => choose(row.value)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                        index === active && "bg-accent",
                      )}
                    >
                      <Check className={cn("size-3.5 shrink-0", chosen ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate", row.custom && "text-muted-foreground")}>{row.label}</span>
                        {row.hint && <span className="block truncate text-xs text-muted-foreground">{row.hint}</span>}
                      </span>
                      {row.badge && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {row.badge}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/* ------------------------------- shared lists ----------------------------- */

/** Every product, as options keyed by SKU — what a bundle or a price book names. */
export function productOptions(
  products: { sku: string; name: string; active: boolean; components?: unknown[] }[],
): ComboboxOption[] {
  return [...products]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map(product => ({
      value: product.sku,
      label: product.sku,
      hint: product.name,
      badge: !product.active ? "inactive" : product.components?.length ? "bundle" : undefined,
    }));
}

/** The distinct families in a catalogue, for the fields that target one. */
export function familyOptions(products: { family: string }[]): ComboboxOption[] {
  const families = [...new Set(products.map(product => product.family.trim()).filter(Boolean))];
  return families.sort((a, b) => a.localeCompare(b)).map(family => ({ value: family, label: family }));
}
