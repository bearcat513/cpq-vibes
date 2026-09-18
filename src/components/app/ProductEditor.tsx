import { useMemo, useState } from "react";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Combobox, familyOptions, productOptions } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Notice } from "./common";
import { localId, type ProductInput } from "@/lib/validate";
import {
  BILLING_PERIODS,
  CHARGE_TYPES,
  CURRENCIES,
  PRODUCT_RULE_KINDS,
  TIER_KINDS,
  type OptionGroup,
  type Product,
  type ProductRule,
  type VolumeTier,
} from "@/lib/types";

type Props = {
  /** null when a product is being created. */
  product: Product | null;
  /** The rest of the catalogue: what a bundle component may name. */
  products: Product[];
  onSave: (input: ProductInput) => Promise<void>;
  onClose: () => void;
};

const BLANK: ProductInput = {
  sku: "",
  name: "",
  description: "",
  family: "",
  chargeType: "recurring",
  billingPeriod: "monthly",
  unitOfMeasure: "unit",
  listPrice: 0,
  cost: 0,
  currency: "USD",
  active: true,
  minQuantity: 1,
  maxQuantity: 0,
  floorDiscountPercent: 0,
  optionGroups: [],
  rules: [],
  components: [],
  volumeTiers: [],
  attributes: {},
};

const toInput = (product: Product | null): ProductInput => {
  if (!product) return structuredClone(BLANK);
  const { id, ownerId, sharedWith, createdAt, updatedAt, ...rest } = product;
  return structuredClone(rest);
};

const slugify = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "option";

type Tab = "basics" | "options" | "rules" | "pricing" | "bundle";

/**
 * Everything a product is.
 *
 * Tabbed rather than one long scroll, because the five parts are edited at
 * completely different times: the basics when the product is created, options
 * and rules when what is sold changes, tiers when the commercials do.
 *
 * Nothing is validated here beyond what stops a form being unusable — the
 * server runs `readProduct` on save and its complaint is the one shown, so
 * there is exactly one definition of a valid product and it is not this file.
 */
export function ProductEditor({ product, products, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<ProductInput>(() => toInput(product));
  const [tab, setTab] = useState<Tab>("basics");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = (changes: Partial<ProductInput>) => setDraft(current => ({ ...current, ...changes }));

  /**
   * The catalogue a component may point at, minus this product — a bundle
   * that contains itself is a loop nothing can price.
   */
  const componentOptions = useMemo(
    () => productOptions(products.filter(entry => entry.sku !== draft.sku)),
    [products, draft.sku],
  );

  const families = useMemo(() => familyOptions(products), [products]);

  /** Every option key on the product, for the rule pickers. */
  const optionKeys = draft.optionGroups.flatMap(group => group.options.map(option => ({ key: option.key, name: option.name })));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this product.");
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ option groups --------------------------- */

  const addGroup = () =>
    patch({
      optionGroups: [
        ...draft.optionGroups,
        {
          id: localId("grp"),
          key: `group_${draft.optionGroups.length + 1}`,
          name: "New group",
          description: "",
          select: "one",
          required: false,
          options: [],
        },
      ],
    });

  const patchGroup = (id: string, changes: Partial<OptionGroup>) =>
    patch({ optionGroups: draft.optionGroups.map(group => (group.id === id ? { ...group, ...changes } : group)) });

  const addOption = (groupId: string) => {
    const group = draft.optionGroups.find(entry => entry.id === groupId);
    if (!group) return;
    patchGroup(groupId, {
      options: [
        ...group.options,
        {
          id: localId("opt"),
          key: `option_${group.options.length + 1}`,
          name: "New option",
          description: "",
          priceDelta: 0,
          priceFactor: 1,
          default: false,
        },
      ],
    });
  };

  /* --------------------------------- render ------------------------------- */

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "basics", label: "Basics" },
    { id: "options", label: "Options", count: draft.optionGroups.length },
    { id: "rules", label: "Rules", count: draft.rules.length },
    { id: "pricing", label: "Volume tiers", count: draft.volumeTiers.length },
    { id: "bundle", label: "Bundle", count: draft.components.length },
  ];

  return (
    <Sheet
      title={product ? `Edit ${product.name}` : "New product"}
      description={product ? product.sku : "A SKU identifies this product everywhere — in bundles, price books and files."}
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
      <div className="sticky -top-3 z-10 mb-3 flex flex-wrap gap-1 border-b bg-background pt-3 pb-2">
        {tabs.map(entry => (
          <Button
            key={entry.id}
            variant={tab === entry.id ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.count ? <Badge tone="outline">{entry.count}</Badge> : null}
          </Button>
        ))}
      </div>

      <div className="space-y-4">
        {tab === "basics" && (
          <>
            <div className="grid gap-3 @md:grid-cols-2">
              <Field label="Name">
                <Input value={draft.name} onChange={event => patch({ name: event.target.value })} autoFocus />
              </Field>
              <Field label="SKU" hint="Letters, digits, dot, dash and underscore.">
                <Input
                  value={draft.sku}
                  onChange={event => patch({ sku: event.target.value.toUpperCase() })}
                  className="font-mono"
                />
              </Field>
              <Field label="Family" hint="Pricing rules can target a whole family.">
                <Combobox
                  value={draft.family}
                  onChange={family => patch({ family })}
                  options={families}
                  emptyLabel="No family"
                  placeholder="Choose or type a family"
                  allowCustom
                  aria-label="Product family"
                />
              </Field>
              <Field label="Unit of measure" hint="Shown on the line: “per user”.">
                <Input value={draft.unitOfMeasure} onChange={event => patch({ unitOfMeasure: event.target.value })} />
              </Field>
            </div>

            <Field label="Description">
              <Textarea value={draft.description} onChange={event => patch({ description: event.target.value })} rows={2} />
            </Field>

            <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
              <Field label="Charge type">
                <Select value={draft.chargeType} onValueChange={value => patch({ chargeType: value as ProductInput["chargeType"] })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHARGE_TYPES.map(type => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {draft.chargeType === "recurring" && (
                <Field label="Billed">
                  <Select
                    value={draft.billingPeriod}
                    onValueChange={value => patch({ billingPeriod: value as ProductInput["billingPeriod"] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BILLING_PERIODS.map(period => (
                        <SelectItem key={period} value={period}>
                          {period}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}

              <Field label="Currency">
                <Select value={draft.currency} onValueChange={value => patch({ currency: value as ProductInput["currency"] })}>
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

            <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
              <Field label="List price">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.listPrice}
                  onChange={event => patch({ listPrice: Number(event.target.value) })}
                />
              </Field>
              <Field label="Unit cost" hint="Drives margin. Never shown to a customer.">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={draft.cost}
                  onChange={event => patch({ cost: Number(event.target.value) })}
                />
              </Field>
              <Field label="Discount ceiling %" hint="Past this, a line needs approval.">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.floorDiscountPercent}
                  onChange={event => patch({ floorDiscountPercent: Number(event.target.value) })}
                />
              </Field>
            </div>

            <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
              <Field label="Minimum quantity">
                <Input
                  type="number"
                  min={0}
                  value={draft.minQuantity}
                  onChange={event => patch({ minQuantity: Number(event.target.value) })}
                />
              </Field>
              <Field label="Maximum quantity" hint="0 is no limit.">
                <Input
                  type="number"
                  min={0}
                  value={draft.maxQuantity}
                  onChange={event => patch({ maxQuantity: Number(event.target.value) })}
                />
              </Field>
              <Field label="Active" hint="Inactive products stay on existing quotes.">
                <div className="flex h-9 items-center">
                  <Switch checked={draft.active} onChange={event => patch({ active: event.target.checked })} />
                </div>
              </Field>
            </div>
          </>
        )}

        {tab === "options" && (
          <>
            {draft.optionGroups.length === 0 && (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                No options. A product with no option groups is quoted as-is.
              </p>
            )}

            {draft.optionGroups.map(group => (
              <div key={group.id} className="rounded-md border">
                <div className="grid gap-2 border-b bg-muted/40 p-3 @md:grid-cols-2 @2xl:grid-cols-4">
                  <Field label="Group name" className="sm:col-span-2">
                    <Input
                      value={group.name}
                      onChange={event =>
                        patchGroup(group.id, { name: event.target.value, key: slugify(event.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Choose">
                    <Select
                      value={group.select}
                      onValueChange={value => patchGroup(group.id, { select: value as "one" | "many" })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="one">One</SelectItem>
                        <SelectItem value="many">Any number</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Required">
                    <div className="flex h-9 items-center gap-2">
                      <Switch
                        checked={group.required}
                        onChange={event => patchGroup(group.id, { required: event.target.checked })}
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          patch({ optionGroups: draft.optionGroups.filter(entry => entry.id !== group.id) })
                        }
                        aria-label={`Remove ${group.name}`}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </Field>
                </div>

                <div className="space-y-2 p-3">
                  {group.options.map(option => (
                    <div key={option.id} className="grid items-end gap-2 @xl:grid-cols-[1fr_5rem_5rem_4rem_2rem]">
                      <Field label="Option">
                        <Input
                          value={option.name}
                          onChange={event =>
                            patchGroup(group.id, {
                              options: group.options.map(entry =>
                                entry.id === option.id
                                  ? { ...entry, name: event.target.value, key: slugify(event.target.value) }
                                  : entry,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="+ Price">
                        <Input
                          type="number"
                          step="0.01"
                          value={option.priceDelta}
                          onChange={event =>
                            patchGroup(group.id, {
                              options: group.options.map(entry =>
                                entry.id === option.id ? { ...entry, priceDelta: Number(event.target.value) } : entry,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="× Factor">
                        <Input
                          type="number"
                          step="0.05"
                          min={0}
                          value={option.priceFactor ?? 1}
                          onChange={event =>
                            patchGroup(group.id, {
                              options: group.options.map(entry =>
                                entry.id === option.id ? { ...entry, priceFactor: Number(event.target.value) } : entry,
                              ),
                            })
                          }
                        />
                      </Field>
                      <Field label="Default">
                        <div className="flex h-9 items-center">
                          <Switch
                            checked={option.default ?? false}
                            onChange={event =>
                              patchGroup(group.id, {
                                options: group.options.map(entry =>
                                  entry.id === option.id ? { ...entry, default: event.target.checked } : entry,
                                ),
                              })
                            }
                          />
                        </div>
                      </Field>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          patchGroup(group.id, { options: group.options.filter(entry => entry.id !== option.id) })
                        }
                        aria-label={`Remove ${option.name}`}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  ))}

                  <Button variant="outline" size="sm" onClick={() => addOption(group.id)}>
                    <Plus /> Option
                  </Button>
                </div>
              </div>
            ))}

            <Button variant="outline" size="sm" onClick={addGroup}>
              <Plus /> Option group
            </Button>
          </>
        )}

        {tab === "rules" && (
          <>
            <p className="text-xs text-muted-foreground">
              Rules are checked whenever a line is configured, in the editor and again on save.
            </p>

            {draft.rules.map(rule => (
              <div key={rule.id} className="space-y-2 rounded-md border p-3">
                <div className="grid gap-2 @md:grid-cols-[7rem_1fr_2rem]">
                  <Field label="Kind">
                    <Select
                      value={rule.kind}
                      onValueChange={value =>
                        patch({
                          rules: draft.rules.map(entry =>
                            entry.id === rule.id ? { ...entry, kind: value as ProductRule["kind"] } : entry,
                          ),
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRODUCT_RULE_KINDS.map(kind => (
                          <SelectItem key={kind} value={kind}>
                            {kind}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Message">
                    <Input
                      value={rule.message}
                      onChange={event =>
                        patch({
                          rules: draft.rules.map(entry =>
                            entry.id === rule.id ? { ...entry, message: event.target.value } : entry,
                          ),
                        })
                      }
                      placeholder="What the rep is told when it fires"
                    />
                  </Field>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="self-end"
                    onClick={() => patch({ rules: draft.rules.filter(entry => entry.id !== rule.id) })}
                    aria-label="Remove rule"
                  >
                    <Trash2 className="text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>

                <OptionKeyPicker
                  label={rule.kind === "validate" ? "Only check when these are selected" : "When these are selected"}
                  keys={optionKeys}
                  selected={rule.when}
                  onChange={when =>
                    patch({ rules: draft.rules.map(entry => (entry.id === rule.id ? { ...entry, when } : entry)) })
                  }
                />

                {rule.kind === "validate" ? (
                  <Field label="Expression" hint="Variables: quantity, termMonths, selectedCount, option.<key>">
                    <Input
                      value={rule.expression ?? ""}
                      onChange={event =>
                        patch({
                          rules: draft.rules.map(entry =>
                            entry.id === rule.id ? { ...entry, expression: event.target.value } : entry,
                          ),
                        })
                      }
                      className="font-mono text-xs"
                      placeholder="quantity >= 25"
                    />
                  </Field>
                ) : (
                  <OptionKeyPicker
                    label={rule.kind === "excludes" ? "These cannot be" : "These must be"}
                    keys={optionKeys}
                    selected={rule.then}
                    onChange={then =>
                      patch({ rules: draft.rules.map(entry => (entry.id === rule.id ? { ...entry, then } : entry)) })
                    }
                  />
                )}
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  rules: [
                    ...draft.rules,
                    { id: localId("prl"), kind: "requires", when: [], then: [], message: "" },
                  ],
                })
              }
              disabled={optionKeys.length === 0}
            >
              <Plus /> Rule
            </Button>
            {optionKeys.length === 0 && (
              <p className="text-xs text-muted-foreground">Add some options first — a rule acts on them.</p>
            )}
          </>
        )}

        {tab === "pricing" && (
          <>
            <p className="text-xs text-muted-foreground">
              The band a quantity falls into sets the whole line's unit price. Tiers are not cumulative.
            </p>

            {draft.volumeTiers.map((tier, index) => (
              <div key={index} className="grid items-end gap-2 @xl:grid-cols-[4rem_4rem_6rem_5rem_2rem]">
                <Field label="From">
                  <Input
                    type="number"
                    min={0}
                    value={tier.minQuantity}
                    onChange={event => patchTier(index, { minQuantity: Number(event.target.value) })}
                  />
                </Field>
                <Field label="To" hint="Blank is “and above”.">
                  <Input
                    type="number"
                    min={0}
                    value={tier.maxQuantity ?? ""}
                    onChange={event =>
                      patchTier(index, { maxQuantity: event.target.value === "" ? null : Number(event.target.value) })
                    }
                  />
                </Field>
                <Field label="Kind">
                  <Select value={tier.kind} onValueChange={value => patchTier(index, { kind: value as VolumeTier["kind"] })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TIER_KINDS.map(kind => (
                        <SelectItem key={kind} value={kind}>
                          {kind === "percent" ? "% off" : kind === "amount" ? "amount off" : "set price"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Value">
                  <Input
                    type="number"
                    step="0.01"
                    value={tier.value}
                    onChange={event => patchTier(index, { value: Number(event.target.value) })}
                  />
                </Field>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => patch({ volumeTiers: draft.volumeTiers.filter((_, at) => at !== index) })}
                  aria-label="Remove tier"
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </div>
            ))}

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  volumeTiers: [
                    ...draft.volumeTiers,
                    {
                      minQuantity: (draft.volumeTiers.at(-1)?.maxQuantity ?? 0) + 1,
                      maxQuantity: null,
                      kind: "percent",
                      value: 0,
                    },
                  ],
                })
              }
            >
              <Plus /> Tier
            </Button>
          </>
        )}

        {tab === "bundle" && (
          <>
            <p className="text-xs text-muted-foreground">
              Components arrive on the quote as their own lines. Give the bundle itself a list price of 0 when the
              components carry the price.
            </p>

            {draft.components.map(component => {
              const known = products.some(entry => entry.sku === component.sku);
              return (
              <div key={component.id} className="grid items-end gap-2 @xl:grid-cols-[1fr_4rem_5rem_4rem_2rem]">
                <Field label="Component">
                  <Combobox
                    value={component.sku}
                    onChange={sku => patchComponent(component.id, { sku: sku.toUpperCase() })}
                    options={componentOptions}
                    placeholder="Choose a product"
                    allowCustom
                    aria-label="Component product"
                  />
                </Field>
                <Field label="Qty">
                  <Input
                    type="number"
                    min={1}
                    value={component.quantity}
                    onChange={event => patchComponent(component.id, { quantity: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Discount %">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={component.discountPercent ?? 0}
                    onChange={event => patchComponent(component.id, { discountPercent: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Required">
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={component.required}
                      onChange={event => patchComponent(component.id, { required: event.target.checked })}
                    />
                  </div>
                </Field>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => patch({ components: draft.components.filter(entry => entry.id !== component.id) })}
                  aria-label="Remove component"
                >
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>

                {component.sku && !known && (
                  <p className="text-xs text-amber-700 @xl:col-span-5 dark:text-amber-400">
                    No product here has the SKU {component.sku}. The bundle will simply not add that line until one
                    does.
                  </p>
                )}
              </div>
              );
            })}

            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch({
                  components: [
                    ...draft.components,
                    { id: localId("cmp"), sku: "", quantity: 1, required: true, discountPercent: 0 },
                  ],
                })
              }
            >
              <Plus /> Component
            </Button>
          </>
        )}
      </div>

      <Notice kind="error" lines={error ? [error] : []} className="mt-3" />
    </Sheet>
  );

  function patchTier(index: number, changes: Partial<VolumeTier>) {
    patch({ volumeTiers: draft.volumeTiers.map((tier, at) => (at === index ? { ...tier, ...changes } : tier)) });
  }

  function patchComponent(id: string, changes: Partial<ProductInput["components"][number]>) {
    patch({ components: draft.components.map(entry => (entry.id === id ? { ...entry, ...changes } : entry)) });
  }
}

/** Option keys as clickable chips — a rule references them, so typing is wrong. */
function OptionKeyPicker({
  label,
  keys,
  selected,
  onChange,
}: {
  label: string;
  keys: { key: string; name: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1">
        {keys.length === 0 && <span className="text-xs text-muted-foreground">No options yet.</span>}
        {keys.map(option => {
          const on = selected.includes(option.key);
          return (
            <button
              key={option.key}
              type="button"
              onClick={() => onChange(on ? selected.filter(key => key !== option.key) : [...selected, option.key])}
              className={
                on
                  ? "rounded-full border border-primary bg-primary px-2 py-0.5 text-xs text-primary-foreground"
                  : "rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
              }
            >
              {option.name}
            </button>
          );
        })}
      </div>
    </Field>
  );
}
