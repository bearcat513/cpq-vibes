import { ChevronDown, ChevronRight, CornerDownRight, Settings2, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, type Formatter } from "./common";
import type { PricedLine, QuoteLineInput } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  /** Priced by the engine on every keystroke; the input is `lines`. */
  priced: PricedLine[];
  format: Formatter;
  /** False once the quote has left the rep's hands. */
  editable: boolean;
  showMargin: boolean;
  onChange: (id: string, patch: Partial<QuoteLineInput>) => void;
  onConfigure: (id: string) => void;
  onRemove: (id: string) => void;
};

/**
 * The lines of a quote.
 *
 * Quantity and discount are edited in place, because those two are what a rep
 * actually moves while someone is on the phone. Everything else — options, the
 * term, a negotiated unit price — is behind the configure dialog, where there
 * is room to show what it costs.
 *
 * Each row can be expanded to show how its price was reached. That panel is
 * the answer to the only hard question in a CPQ, so it reads as a sum: list,
 * then each thing that moved it, then what is charged.
 */
export function QuoteLines({ priced, format, editable, showMargin, onChange, onConfigure, onRemove }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!priced.length) {
    return (
      <EmptyState title="Nothing on this quote yet">
        Add a product to start pricing. Totals, approvals and the proposal all follow from the lines.
      </EmptyState>
    );
  }

  return (
    <Table>
      <Thead>
        <Tr>
          <Th className="w-8" aria-label="Expand" />
          <Th>Item</Th>
          <Th numeric className="w-24">
            Qty
          </Th>
          <Th numeric className="w-28">
            List
          </Th>
          <Th numeric className="w-24">
            Disc %
          </Th>
          <Th numeric className="w-28">
            Unit
          </Th>
          <Th numeric className="w-32">
            Total
          </Th>
          {showMargin && (
            <Th numeric className="w-24">
              Margin
            </Th>
          )}
          {editable && <Th className="w-20" aria-label="Actions" />}
        </Tr>
      </Thead>

      <Tbody>
        {priced.map(line => {
          const open = expanded === line.id;
          const isComponent = Boolean(line.parentId);
          const hasProblem = line.issues.length > 0;

          return [
            <Tr key={line.id} className={cn(hasProblem && "bg-destructive/5")}>
              <Td>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setExpanded(open ? null : line.id)}
                  aria-label={open ? "Hide the price breakdown" : "Show the price breakdown"}
                >
                  {open ? <ChevronDown /> : <ChevronRight />}
                </Button>
              </Td>

              <Td>
                <div className={cn("min-w-0", isComponent && "pl-4")}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isComponent && <CornerDownRight className="size-3 shrink-0 text-muted-foreground" />}
                    <span className="font-medium">{line.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{line.sku}</span>
                    {line.chargeType === "recurring" && (
                      <Badge tone="outline">
                        {line.billingPeriod} · {line.termMonths}mo
                      </Badge>
                    )}
                    {line.chargeType === "usage" && <Badge tone="outline">usage</Badge>}
                    {line.appliedRules.length > 0 && (
                      <Badge tone="info" title={line.appliedRules.map(rule => rule.name).join(", ")}>
                        <Wand2 /> {line.appliedRules.length}
                      </Badge>
                    )}
                  </div>
                  {line.optionNames.length > 0 && (
                    <p className="text-xs text-muted-foreground">{line.optionNames.join(" · ")}</p>
                  )}
                  {line.description && <p className="text-xs text-muted-foreground">{line.description}</p>}
                  {line.issues.map(issue => (
                    <p key={issue} className="text-xs text-destructive">
                      {issue}
                    </p>
                  ))}
                  {line.warnings.map(warning => (
                    <p key={warning} className="text-xs text-amber-700 dark:text-amber-400">
                      {warning}
                    </p>
                  ))}
                </div>
              </Td>

              <Td numeric>
                {editable ? (
                  <Input
                    type="number"
                    min={0}
                    value={line.quantity}
                    onChange={event => onChange(line.id, { quantity: Number(event.target.value) })}
                    className="h-8 w-20 text-right"
                    aria-label={`Quantity of ${line.name}`}
                  />
                ) : (
                  line.quantity
                )}
              </Td>

              <Td numeric className="text-muted-foreground">
                {format.money(line.listUnitPrice)}
              </Td>

              <Td numeric>
                {editable ? (
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.5"
                    value={line.discountPercent}
                    onChange={event => onChange(line.id, { discountPercent: Number(event.target.value) })}
                    className="h-8 w-20 text-right"
                    aria-label={`Discount on ${line.name}`}
                  />
                ) : (
                  format.percent(line.effectiveDiscountPercent)
                )}
              </Td>

              <Td numeric>
                <span className={cn(line.unitPriceOverride !== null && "font-medium underline decoration-dotted")}>
                  {format.money(line.unitPrice)}
                </span>
              </Td>

              <Td numeric className="font-medium">
                {format.money(line.netTotal)}
              </Td>

              {showMargin && (
                <Td numeric className={cn(line.marginPercent < 30 ? "text-destructive" : "text-muted-foreground")}>
                  {format.percent(line.marginPercent)}
                </Td>
              )}

              {editable && (
                <Td>
                  <div className="flex justify-end gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onConfigure(line.id)}
                      aria-label={`Configure ${line.name}`}
                      title="Options, term and unit price"
                    >
                      <Settings2 />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemove(line.id)}
                      aria-label={`Remove ${line.name}`}
                      title="Remove"
                    >
                      <Trash2 className="text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>
                </Td>
              )}
            </Tr>,

            open && (
              <Tr key={`${line.id}-detail`} className="bg-muted/30 hover:bg-muted/30">
                <Td />
                <Td colSpan={showMargin ? (editable ? 8 : 7) : editable ? 7 : 6}>
                  <dl className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
                    <Row label="Price book / list" value={format.money(line.listUnitPrice)} />
                    {line.optionsUnitDelta !== 0 && (
                      <Row label="Options" value={`${line.optionsUnitDelta > 0 ? "+" : ""}${format.money(line.optionsUnitDelta)}`} />
                    )}
                    {line.tier && (
                      <Row
                        label={`Volume tier ${line.tier.minQuantity}${line.tier.maxQuantity ? `–${line.tier.maxQuantity}` : "+"}`}
                        value={
                          line.tier.kind === "override"
                            ? `set to ${format.money(line.tier.value)}`
                            : line.tier.kind === "percent"
                              ? `−${format.percent(line.tier.value)}`
                              : `−${format.money(line.tier.value)}`
                        }
                      />
                    )}
                    {line.unitPriceOverride !== null && (
                      <Row label="Negotiated unit price" value={format.money(line.unitPriceOverride)} />
                    )}
                    {line.appliedRules.map(rule => (
                      <Row
                        key={rule.ruleId}
                        label={`Rule: ${rule.name}`}
                        value={
                          rule.target === "discountPercent"
                            ? `discount ${format.percent(rule.from)} → ${format.percent(rule.to)}`
                            : rule.target === "unitPrice"
                              ? `${format.money(rule.from)} → ${format.money(rule.to)}`
                              : `${format.money(rule.to - rule.from)} adjustment`
                        }
                      />
                    ))}
                    <Row label="Charged per unit" value={format.money(line.unitPrice)} />
                    <Row
                      label="Billing periods"
                      value={
                        line.chargeType === "recurring"
                          ? `${line.periods} × ${line.billingPeriod} over ${line.termMonths} months`
                          : "once"
                      }
                    />
                    <Row label="At list" value={format.money(line.listTotal)} />
                    <Row label="Discount" value={`−${format.money(line.discountAmount)} (${format.percent(line.effectiveDiscountPercent)})`} />
                    {showMargin && <Row label="Cost" value={format.money(line.costTotal)} />}
                    {showMargin && <Row label="Margin" value={`${format.money(line.margin)} (${format.percent(line.marginPercent)})`} />}
                    {line.chargeType === "recurring" && (
                      <Row label="Monthly recurring" value={format.money(line.monthlyRecurring)} />
                    )}
                  </dl>
                </Td>
              </Tr>
            ),
          ];
        })}
      </Tbody>
    </Table>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed border-border/60 py-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
