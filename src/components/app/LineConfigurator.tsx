import { useMemo, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Field, Notice, formatters } from "./common";
import { toggleOption, validateConfiguration } from "@/lib/configurator";
import { tierFor } from "@/lib/pricing";
import { round } from "@/lib/money";
import type { CurrencyCode, Product, QuoteLineInput } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  product: Product;
  line: QuoteLineInput;
  currency: CurrencyCode;
  locale: string;
  /** The quote's term, used when the line does not name its own. */
  quoteTermMonths: number;
  onSave: (line: QuoteLineInput) => void;
  onClose: () => void;
};

/**
 * Configuring one line: which options, how many, for how long.
 *
 * Everything recomputes as you click, because the only question worth
 * answering here is "what does that do to the price" — and the answer runs the
 * same `validateConfiguration` the server runs on save, so the dialog can
 * never say a configuration is fine that the server will then refuse.
 */
export function LineConfigurator({ product, line, currency, locale, quoteTermMonths, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<QuoteLineInput>(line);
  const format = formatters(currency, locale);

  const termMonths = draft.termMonths || quoteTermMonths;

  const result = useMemo(
    () =>
      validateConfiguration(
        product,
        { selectedOptions: draft.selectedOptions, quantity: draft.quantity, termMonths },
        currency,
      ),
    [product, draft.selectedOptions, draft.quantity, termMonths, currency],
  );

  // The unit price this configuration lands on, before discounts — the same
  // first three steps the pricing engine takes.
  const tier = tierFor(product.volumeTiers, draft.quantity);
  const optioned = round(product.listPrice * result.unitFactor + result.unitDelta, currency);
  const tiered =
    tier === null
      ? optioned
      : tier.kind === "override"
        ? round(tier.value, currency)
        : tier.kind === "amount"
          ? round(optioned - tier.value, currency)
          : round(optioned * (1 - tier.value / 100), currency);

  const set = (patch: Partial<QuoteLineInput>) => setDraft(current => ({ ...current, ...patch }));

  // The buttons move by whatever the product is sold in, so a pack of four
  // never lands on a quantity the configurator is about to reject.
  const increment = Math.max(1, product.quantityIncrement ?? 1);
  const step = (direction: number) =>
    set({ quantity: Math.max(product.minQuantity || increment, draft.quantity + direction * increment) });

  return (
    <Sheet
      title={`Configure ${product.name}`}
      description={`${product.sku} · ${format.money(product.listPrice, product.currency)} per ${product.unitOfMeasure}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave({ ...draft, selectedOptions: result.selected })}>
            <Check /> Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
          <Field
            label={`Quantity (${product.unitOfMeasure})`}
            hint={increment > 1 ? `Sold in multiples of ${increment}.` : undefined}
          >
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" onClick={() => step(-1)} aria-label={increment > 1 ? `${increment} fewer` : "One fewer"}>
                <Minus />
              </Button>
              <Input
                type="number"
                min={product.minQuantity || 0}
                step={increment}
                value={draft.quantity}
                onChange={event => set({ quantity: Number(event.target.value) })}
                className="text-center"
              />
              <Button variant="outline" size="icon-sm" onClick={() => step(1)} aria-label={increment > 1 ? `${increment} more` : "One more"}>
                <Plus />
              </Button>
            </div>
          </Field>

          {product.chargeType === "recurring" && (
            <Field label="Term (months)" hint={draft.termMonths ? undefined : `Using the quote's ${quoteTermMonths}`}>
              <Input
                type="number"
                min={0}
                value={draft.termMonths || ""}
                placeholder={String(quoteTermMonths)}
                onChange={event => set({ termMonths: Number(event.target.value) })}
              />
            </Field>
          )}

          <Field label="Discount %">
            <Input
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={draft.discountPercent}
              onChange={event => set({ discountPercent: Number(event.target.value) })}
            />
          </Field>
        </div>

        {/* Hidden groups are not drawn at all — not greyed out. A group whose
            `visibleWhen` is false is not a choice being withheld, it is a question
            this configuration does not raise, and the same `validateConfiguration`
            the server runs is what decides. */}
        {product.optionGroups.filter(group => result.visibleGroups.includes(group.key)).map(group => {
          const offered = group.options.filter(option => result.visibleOptions.includes(option.key));
          const chosen = offered.filter(option => draft.selectedOptions.includes(option.key)).length;
          return (
            <div key={group.id} className="rounded-md border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {group.name}
                    {group.required && <span className="ml-1 text-destructive">*</span>}
                  </p>
                  {group.description && <p className="text-xs text-muted-foreground">{group.description}</p>}
                </div>
                <Badge tone="outline">
                  {group.select === "one" ? "choose one" : `choose any${group.maxSelect ? ` (max ${group.maxSelect})` : ""}`}
                  {group.select === "many" && chosen > 0 ? ` · ${chosen}` : ""}
                </Badge>
              </div>

              <ul className="divide-y">
                {offered.map(option => {
                  const on = draft.selectedOptions.includes(option.key);
                  // What this one option is worth per unit, at the current
                  // list price — the number the buyer is actually weighing.
                  const delta = round(
                    product.listPrice * ((option.priceFactor ?? 1) - 1) + option.priceDelta,
                    currency,
                  );

                  return (
                    <li key={option.id}>
                      <button
                        type="button"
                        onClick={() =>
                          set({ selectedOptions: toggleOption(product, draft.selectedOptions, option.key, !on) })
                        }
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent",
                          on && "bg-primary/5",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center border",
                            group.select === "one" ? "rounded-full" : "rounded-sm",
                            on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                          )}
                        >
                          {on && <Check className="size-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{option.name}</span>
                          {option.description && (
                            <span className="block text-xs text-muted-foreground">{option.description}</span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {delta === 0 ? "included" : `${delta > 0 ? "+" : ""}${format.money(delta)}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        <Notice kind="error" lines={result.errors} />
        <Notice kind="warning" lines={result.warnings} />

        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">List, with options</span>
            <span className="tabular-nums">{format.money(optioned)}</span>
          </div>
          {tier && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                Volume tier ({tier.minQuantity}
                {tier.maxQuantity ? `–${tier.maxQuantity}` : "+"})
              </span>
              <span className="tabular-nums">{format.money(tiered)}</span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between border-t pt-1 font-medium">
            <span>
              Unit price
              {draft.discountPercent > 0 ? ` after ${format.percent(draft.discountPercent)}` : ""}
            </span>
            <span className="tabular-nums">
              {format.money(round(tiered * (1 - draft.discountPercent / 100), currency))}
            </span>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
