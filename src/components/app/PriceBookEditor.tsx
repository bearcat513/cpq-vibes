import { useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Combobox, productOptions } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Notice } from "./common";
import { CURRENCIES, type PriceBook, type Product } from "@/lib/types";
import type { PriceBookInput } from "@/lib/validate";

type Props = {
  book: PriceBook | null;
  products: Product[];
  onSave: (input: PriceBookInput) => Promise<void>;
  onClose: () => void;
};

const toInput = (book: PriceBook | null): PriceBookInput =>
  book
    ? {
        name: book.name,
        description: book.description,
        currency: book.currency,
        isDefault: book.isDefault,
        active: book.active,
        validFrom: book.validFrom,
        validTo: book.validTo,
        entries: structuredClone(book.entries),
      }
    : {
        name: "",
        description: "",
        currency: "USD",
        isDefault: false,
        active: true,
        validFrom: "",
        validTo: "",
        entries: [],
      };

/**
 * A price book: one price per product, and the floor beneath it.
 *
 * The floor is the field worth understanding. A discount, a volume tier and a
 * pricing rule can all push a price down; the floor is the one number none of
 * them may cross. Leave it blank and there is nothing stopping a 90% discount
 * from going out of the door.
 */
export function PriceBookEditor({ book, products, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<PriceBookInput>(() => toInput(book));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = (changes: Partial<PriceBookInput>) => setDraft(current => ({ ...current, ...changes }));

  const priced = new Set(draft.entries.map(entry => entry.sku));
  const missing = products.filter(product => !priced.has(product.sku));

  const skus = productOptions(products);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this price book.");
    } finally {
      setBusy(false);
    }
  };

  /** Every catalogue product at its list price — the usual starting point. */
  const fillFromCatalogue = () =>
    patch({
      entries: [
        ...draft.entries,
        ...missing.map(product => ({
          sku: product.sku,
          unitPrice: product.listPrice,
          minPrice: null,
          active: true,
        })),
      ],
    });

  return (
    <Sheet
      title={book ? `Edit ${book.name}` : "New price book"}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Name">
            <Input value={draft.name} onChange={event => patch({ name: event.target.value })} autoFocus />
          </Field>
          <Field label="Currency" hint="A quote can only use a book in its own currency.">
            <Select value={draft.currency} onValueChange={value => patch({ currency: value as PriceBookInput["currency"] })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map(code => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="Description">
          <Textarea value={draft.description} onChange={event => patch({ description: event.target.value })} rows={2} />
        </Field>

        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-4">
          <Field label="Valid from">
            <Input type="date" value={draft.validFrom} onChange={event => patch({ validFrom: event.target.value })} />
          </Field>
          <Field label="Valid to">
            <Input type="date" value={draft.validTo} onChange={event => patch({ validTo: event.target.value })} />
          </Field>
          <Field label="Default" hint="Used when a quote names none.">
            <div className="flex h-9 items-center">
              <Switch checked={draft.isDefault} onChange={event => patch({ isDefault: event.target.checked })} />
            </div>
          </Field>
          <Field label="Active">
            <div className="flex h-9 items-center">
              <Switch checked={draft.active} onChange={event => patch({ active: event.target.checked })} />
            </div>
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Prices ({draft.entries.length})</p>
            {missing.length > 0 && (
              <Button variant="outline" size="sm" onClick={fillFromCatalogue}>
                <Plus /> Add the {missing.length} missing at list
              </Button>
            )}
          </div>

          {draft.entries.length === 0 && (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              No prices yet. A product with no entry here falls back to its catalogue list price.
            </p>
          )}

          {draft.entries.map((entry, index) => {
            const product = products.find(candidate => candidate.sku === entry.sku);
            return (
              <div key={index} className="grid items-end gap-2 @xl:grid-cols-[1fr_5.5rem_5.5rem_3.5rem_2rem]">
                <Field label={index === 0 ? "SKU" : ""}>
                  <Combobox
                    value={entry.sku}
                    onChange={sku => patchEntry(index, { sku: sku.toUpperCase() })}
                    options={skus}
                    placeholder="Choose a product"
                    allowCustom
                    aria-label="Product this price is for"
                  />
                  {product ? (
                    <span className="text-xs text-muted-foreground">{product.name}</span>
                  ) : entry.sku ? (
                    <span className="text-xs text-amber-700 dark:text-amber-400">Not in this catalogue</span>
                  ) : null}
                </Field>
                <Field label={index === 0 ? "Unit price" : ""}>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={entry.unitPrice}
                    onChange={event => patchEntry(index, { unitPrice: Number(event.target.value) })}
                  />
                </Field>
                <Field label={index === 0 ? "Floor" : ""}>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={entry.minPrice ?? ""}
                    placeholder="none"
                    onChange={event =>
                      patchEntry(index, { minPrice: event.target.value === "" ? null : Number(event.target.value) })
                    }
                  />
                </Field>
                <Field label={index === 0 ? "Active" : ""}>
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={entry.active !== false}
                      onChange={event => patchEntry(index, { active: event.target.checked })}
                    />
                  </div>
                </Field>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => patch({ entries: draft.entries.filter((_, at) => at !== index) })}
                  aria-label={`Remove ${entry.sku}`}
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            );
          })}

          <Button
            variant="outline"
            size="sm"
            onClick={() => patch({ entries: [...draft.entries, { sku: "", unitPrice: 0, minPrice: null, active: true }] })}
          >
            <Plus /> Price
          </Button>
        </div>
      </div>

      <Notice kind="error" lines={error ? [error] : []} className="mt-3" />
    </Sheet>
  );

  function patchEntry(index: number, changes: Partial<PriceBookInput["entries"][number]>) {
    patch({ entries: draft.entries.map((entry, at) => (at === index ? { ...entry, ...changes } : entry)) });
  }
}
