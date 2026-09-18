import { useMemo, useState } from "react";
import { Package, Layers, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { formatters } from "./common";
import type { CurrencyCode, Product } from "@/lib/types";

type Props = {
  products: Product[];
  /** The quote's currency, so a product it cannot be priced in is flagged. */
  currency: CurrencyCode;
  locale: string;
  onPick: (product: Product) => void;
  onClose: () => void;
};

/**
 * Choosing what to put on a quote.
 *
 * Grouped by family and searchable by name or SKU, because a catalogue of any
 * size is unusable as one flat list and reps think in families. Inactive
 * products are left out entirely: they are in the catalogue for the quotes
 * that already reference them, not for new ones.
 */
export function ProductPicker({ products, currency, locale, onPick, onClose }: Props) {
  const [search, setSearch] = useState("");
  const format = formatters(currency, locale);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matching = products.filter(
      product =>
        product.active &&
        (!needle ||
          product.name.toLowerCase().includes(needle) ||
          product.sku.toLowerCase().includes(needle) ||
          product.family.toLowerCase().includes(needle)),
    );

    const byFamily = new Map<string, Product[]>();
    for (const product of matching) {
      const family = product.family || "Uncategorised";
      byFamily.set(family, [...(byFamily.get(family) ?? []), product]);
    }
    return [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [products, search]);

  return (
    <Sheet title="Add a product" onClose={onClose}>
      <div className="sticky -top-3 z-10 mb-3 bg-background pt-3 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search by name, SKU or family"
            className="pl-8"
            autoFocus
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-8 text-center text-xs text-muted-foreground">
          {products.length ? "Nothing matches that." : "There are no products yet — add some to the catalogue first."}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(([family, entries]) => (
            <div key={family}>
              <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{family}</p>
              <ul className="divide-y rounded-md border">
                {entries.map(product => {
                  const wrongCurrency = product.currency !== currency;
                  return (
                    <li key={product.id}>
                      <button
                        type="button"
                        onClick={() => onPick(product)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent"
                      >
                        {product.components.length ? (
                          <Layers className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <Package className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{product.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
                            {product.optionGroups.length > 0 && <Badge tone="outline">configurable</Badge>}
                            {product.components.length > 0 && <Badge tone="info">bundle</Badge>}
                            {wrongCurrency && <Badge tone="pending">{product.currency}</Badge>}
                          </span>
                          {product.description && (
                            <span className="line-clamp-1 text-xs text-muted-foreground">{product.description}</span>
                          )}
                        </span>
                        <span className="shrink-0 text-right text-sm tabular-nums">
                          {format.money(product.listPrice, product.currency)}
                          <span className="block text-xs text-muted-foreground">
                            per {product.unitOfMeasure}
                            {product.chargeType === "recurring" ? ` · ${product.billingPeriod}` : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        A bundle adds its components as their own lines, so the customer sees what they are getting.
      </p>
    </Sheet>
  );
}
