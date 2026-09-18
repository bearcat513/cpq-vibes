import { useEffect, useState } from "react";
import { Check, Loader2, Mail, Pencil, Plus, ShieldAlert, Trash2, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Combobox, familyOptions, productOptions } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, Field, Notice, Section } from "./common";
import { api, type DirectoryUser } from "@/lib/api";
import { PRICING_VARIABLES } from "@/lib/pricing";
import { parseFormula } from "@/lib/formula";
import {
  APPROVAL_METRICS,
  APPROVAL_METRIC_LABELS,
  COMPARATORS,
  PRICING_RULE_TARGETS,
  type ApprovalRule,
  type PricingRule,
  type Product,
} from "@/lib/types";
import type { ApprovalRuleInput, PricingRuleInput } from "@/lib/validate";

type Props = {
  pricingRules: PricingRule[];
  approvalRules: ApprovalRule[];
  /** The catalogue the rules point into. */
  products: Product[];
  /** Everyone with an account here, for the approver picker. */
  directory: DirectoryUser[];
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
  confirmed: (message: string) => boolean;
};

/**
 * Commercial policy: what changes a price, and what needs a second opinion.
 *
 * Both kinds of rule are data rather than code, and both are written as
 * formulas over the same variables the pricing engine uses, so the two
 * editors are deliberately similar — a rule that adjusts a price and a rule
 * that flags one are the same kind of thinking.
 */
export function RulesView({ pricingRules, approvalRules, products, directory, onChanged, onError, confirmed }: Props) {
  const [editingPricing, setEditingPricing] = useState<PricingRule | null | undefined>(undefined);
  const [editingApproval, setEditingApproval] = useState<ApprovalRule | null | undefined>(undefined);

  const remove = async (what: "pricing" | "approval", id: string, name: string) => {
    if (!confirmed(`Delete the rule “${name}”?`)) return;
    try {
      if (what === "pricing") await api.deletePricingRule(id);
      else await api.deleteApprovalRule(id);
      await onChanged();
    } catch (error) {
      onError(error);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Pricing rules"
        description="Applied in priority order, each one seeing what the last one produced."
        actions={
          <Button size="sm" onClick={() => setEditingPricing(null)}>
            <Plus /> New pricing rule
          </Button>
        }
      >
        {pricingRules.length === 0 ? (
          <EmptyState title="No pricing rules">
            A rule is how a commercial policy — “20% off above 500 seats” — becomes something the quote applies by itself.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th numeric className="w-16">
                  Priority
                </Th>
                <Th>Rule</Th>
                <Th>Applies to</Th>
                <Th>When</Th>
                <Th>Sets</Th>
                <Th className="w-20" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {pricingRules.map(rule => (
                <Tr key={rule.id} className={rule.active ? undefined : "opacity-60"}>
                  <Td numeric className="text-muted-foreground">
                    {rule.priority}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Wand2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{rule.name}</span>
                      {!rule.active && <Badge tone="neutral">off</Badge>}
                    </div>
                    {rule.description && <p className="line-clamp-1 text-xs text-muted-foreground">{rule.description}</p>}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {rule.scope === "quote"
                      ? "the whole quote"
                      : [rule.appliesToSku, rule.appliesToFamily].filter(Boolean).join(" · ") || "any line"}
                  </Td>
                  <Td>
                    <code className="text-xs">{rule.condition || "always"}</code>
                  </Td>
                  <Td>
                    <code className="text-xs">
                      {rule.target} = {rule.expression}
                    </code>
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditingPricing(rule)} aria-label={`Edit ${rule.name}`}>
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void remove("pricing", rule.id, rule.name)}
                        aria-label={`Delete ${rule.name}`}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      <Section
        title="Approval rules"
        description="Levels are cumulative — a quote needs every level at or below the highest it trips."
        actions={
          <Button size="sm" onClick={() => setEditingApproval(null)}>
            <Plus /> New approval rule
          </Button>
        }
      >
        {approvalRules.length === 0 ? (
          <EmptyState title="No approval rules">
            Without one, every quote can be sent by whoever wrote it.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th numeric className="w-16">
                  Level
                </Th>
                <Th>Rule</Th>
                <Th>Fires when</Th>
                <Th>Approver</Th>
                <Th className="w-20" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {approvalRules.map(rule => (
                <Tr key={rule.id} className={rule.active ? undefined : "opacity-60"}>
                  <Td numeric className="text-muted-foreground">
                    {rule.level}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ShieldAlert className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{rule.name}</span>
                      <Badge tone="outline">{rule.scope}</Badge>
                      {!rule.active && <Badge tone="neutral">off</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <code className="text-xs">
                      {rule.metric === "custom"
                        ? rule.condition
                        : rule.metric === "floorBreach"
                          ? `a line is past its product's ceiling by more than ${rule.threshold}%`
                          : `${rule.metric} ${rule.comparator} ${rule.threshold}`}
                    </code>
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {rule.approvers.length === 0 ? (
                      <span className="text-amber-700 dark:text-amber-400">nobody — skipped</span>
                    ) : (
                      <>
                        <span className="block truncate">{rule.approvers.join(", ")}</span>
                        {rule.approvers.length > 1 && (
                          <span className="block">
                            {rule.approvalsRequired} of {rule.approvers.length} to approve ·{" "}
                            {rule.rejectionsRequired} to reject
                          </span>
                        )}
                      </>
                    )}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditingApproval(rule)} aria-label={`Edit ${rule.name}`}>
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void remove("approval", rule.id, rule.name)}
                        aria-label={`Delete ${rule.name}`}
                      >
                        <Trash2 className="text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {editingPricing !== undefined && (
        <PricingRuleEditor
          rule={editingPricing}
          products={products}
          onSave={async input => {
            if (editingPricing) await api.updatePricingRule(editingPricing.id, input);
            else await api.createPricingRule(input);
            await onChanged();
            setEditingPricing(undefined);
          }}
          onClose={() => setEditingPricing(undefined)}
        />
      )}

      {editingApproval !== undefined && (
        <ApprovalRuleEditor
          rule={editingApproval}
          directory={directory}
          knownApprovers={[...new Set(approvalRules.flatMap(entry => entry.approvers).filter(Boolean))]}
          onSave={async input => {
            if (editingApproval) await api.updateApprovalRule(editingApproval.id, input);
            else await api.createApprovalRule(input);
            await onChanged();
            setEditingApproval(undefined);
          }}
          onClose={() => setEditingApproval(undefined)}
        />
      )}
    </div>
  );
}

/* ------------------------------ formula input ----------------------------- */

/**
 * An expression box that checks itself as it is typed.
 *
 * Validation runs locally against the scope's variable list — the same
 * `parseFormula` the server uses — so the feedback is immediate and cannot
 * disagree with what the save will do. The clickable variables matter more
 * than they look: nobody remembers whether it is `listPrice` or `list_price`.
 */
function FormulaInput({
  label,
  hint,
  value,
  scope,
  optional,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  scope: "line" | "quote";
  optional?: boolean;
  onChange: (value: string) => void;
}) {
  const variables = PRICING_VARIABLES[scope];
  const [error, setError] = useState("");

  useEffect(() => {
    if (!value.trim()) {
      setError(optional ? "" : "Enter an expression.");
      return;
    }
    const result = parseFormula(
      value,
      variables.map(variable => variable.name),
    );
    setError(result.ok ? "" : result.error);
  }, [value, variables, optional]);

  return (
    <Field label={label} hint={hint}>
      <Input
        value={value}
        onChange={event => onChange(event.target.value)}
        className="font-mono text-xs"
        aria-invalid={Boolean(error)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-1">
        {variables.map(variable => (
          <button
            key={variable.name}
            type="button"
            title={variable.description}
            onClick={() => onChange(`${value}${value && !value.endsWith(" ") ? " " : ""}${variable.name}`)}
            className="rounded border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent"
          >
            {variable.name}
          </button>
        ))}
      </div>
    </Field>
  );
}

/* --------------------------- pricing rule editor -------------------------- */

const BLANK_PRICING: PricingRuleInput = {
  name: "",
  description: "",
  scope: "line",
  condition: "",
  target: "discountPercent",
  expression: "",
  appliesToFamily: "",
  appliesToSku: "",
  priority: 100,
  active: true,
  message: "",
};

function PricingRuleEditor({
  rule,
  products,
  onSave,
  onClose,
}: {
  rule: PricingRule | null;
  products: Product[];
  onSave: (input: PricingRuleInput) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PricingRuleInput>(() => {
    if (!rule) return { ...BLANK_PRICING };
    const { id, ownerId, createdAt, updatedAt, ...rest } = rule;
    return rest;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = (changes: Partial<PricingRuleInput>) => setDraft(current => ({ ...current, ...changes }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this rule.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={rule ? `Edit ${rule.name}` : "New pricing rule"}
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
          <Field label="Priority" hint="Lowest first.">
            <Input
              type="number"
              min={0}
              value={draft.priority}
              onChange={event => patch({ priority: Number(event.target.value) })}
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea value={draft.description} onChange={event => patch({ description: event.target.value })} rows={2} />
        </Field>

        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
          <Field label="Scope">
            <Select
              value={draft.scope}
              onValueChange={value =>
                patch({
                  scope: value as PricingRuleInput["scope"],
                  // `unitPrice` has no meaning for a whole quote; the server
                  // refuses it, so do not let the form reach that state.
                  target: value === "quote" && draft.target === "unitPrice" ? "discountPercent" : draft.target,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="line">Each line</SelectItem>
                <SelectItem value="quote">The whole quote</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Sets">
            <Select value={draft.target} onValueChange={value => patch({ target: value as PricingRuleInput["target"] })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRICING_RULE_TARGETS.filter(target => draft.scope === "line" || target !== "unitPrice").map(target => (
                  <SelectItem key={target} value={target}>
                    {target}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Active">
            <div className="flex h-9 items-center">
              <Switch checked={draft.active} onChange={event => patch({ active: event.target.checked })} />
            </div>
          </Field>
        </div>

        {draft.scope === "line" && (
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label="Only this family">
              <Combobox
                value={draft.appliesToFamily}
                onChange={appliesToFamily => patch({ appliesToFamily })}
                options={familyOptions(products)}
                emptyLabel="Any family"
                placeholder="Any family"
                allowCustom
                aria-label="Family this rule applies to"
              />
            </Field>
            <Field label="Only this SKU">
              <Combobox
                value={draft.appliesToSku}
                onChange={appliesToSku => patch({ appliesToSku: appliesToSku.toUpperCase() })}
                options={productOptions(products)}
                emptyLabel="Any product"
                placeholder="Any product"
                allowCustom
                aria-label="Product this rule applies to"
              />
            </Field>
          </div>
        )}

        <FormulaInput
          label="Condition"
          hint="Blank means it always applies."
          value={draft.condition}
          scope={draft.scope}
          optional
          onChange={condition => patch({ condition })}
        />

        <FormulaInput
          label={`Expression — the new ${draft.target}`}
          value={draft.expression}
          scope={draft.scope}
          onChange={expression => patch({ expression })}
        />

        <Field label="Message" hint="Shown on the line this rule changed.">
          <Input value={draft.message} onChange={event => patch({ message: event.target.value })} />
        </Field>
      </div>

      <Notice kind="error" lines={error ? [error] : []} className="mt-3" />
    </Sheet>
  );
}

/* -------------------------- approval rule editor -------------------------- */

const BLANK_APPROVAL: ApprovalRuleInput = {
  name: "",
  scope: "quote",
  metric: "discountPercent",
  comparator: ">",
  threshold: 15,
  condition: "",
  level: 1,
  approvers: [],
  approvalsRequired: 1,
  rejectionsRequired: 1,
  message: "",
  active: true,
};

function ApprovalRuleEditor({
  rule,
  directory,
  knownApprovers,
  onSave,
  onClose,
}: {
  rule: ApprovalRule | null;
  /** Everyone with an account here. */
  directory: DirectoryUser[];
  /**
   * Addresses this account's own rules already name.
   *
   * Kept alongside the directory rather than replaced by it: an approver may
   * have been named before they registered, and dropping them off the list
   * would quietly hide a rule nobody can answer.
   */
  knownApprovers: string[];
  onSave: (input: ApprovalRuleInput) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ApprovalRuleInput>(() => {
    if (!rule) return { ...BLANK_APPROVAL };
    const { id, ownerId, createdAt, updatedAt, ...rest } = rule;
    return rest;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = (changes: Partial<ApprovalRuleInput>) => setDraft(current => ({ ...current, ...changes }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this rule.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={rule ? `Edit ${rule.name}` : "New approval rule"}
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
        <Field label="Name">
          <Input value={draft.name} onChange={event => patch({ name: event.target.value })} autoFocus />
        </Field>

        <ApproverList
          approvers={draft.approvers}
          approvalsRequired={draft.approvalsRequired}
          rejectionsRequired={draft.rejectionsRequired}
          directory={directory}
          known={knownApprovers}
          onChange={patch}
        />

        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
          <Field label="Level" hint="Every level at or below the highest tripped is asked.">
            <Input
              type="number"
              min={1}
              max={20}
              value={draft.level}
              onChange={event => patch({ level: Number(event.target.value) })}
            />
          </Field>
          <Field label="Weighs">
            <Select value={draft.scope} onValueChange={value => patch({ scope: value as ApprovalRuleInput["scope"] })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quote">The whole quote</SelectItem>
                <SelectItem value="line">Any single line</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Active">
            <div className="flex h-9 items-center">
              <Switch checked={draft.active} onChange={event => patch({ active: event.target.checked })} />
            </div>
          </Field>
        </div>

        <Field label="Metric" hint={APPROVAL_METRIC_LABELS[draft.metric]}>
          <Select value={draft.metric} onValueChange={value => patch({ metric: value as ApprovalRuleInput["metric"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {APPROVAL_METRICS.map(metric => (
                <SelectItem key={metric} value={metric}>
                  {metric}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {draft.metric === "custom" ? (
          <FormulaInput
            label="Condition — it fires when this is true"
            value={draft.condition}
            scope={draft.scope}
            onChange={condition => patch({ condition })}
          />
        ) : (
          <div className="grid gap-3 @md:grid-cols-2">
            <Field label="Comparator">
              <Select
                value={draft.comparator}
                onValueChange={value => patch({ comparator: value as ApprovalRuleInput["comparator"] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPARATORS.map(comparator => (
                    <SelectItem key={comparator} value={comparator}>
                      {comparator}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Threshold"
              hint={draft.metric === "floorBreach" ? "Percentage points past the product's own ceiling." : undefined}
            >
              <Input
                type="number"
                step="0.5"
                value={draft.threshold}
                onChange={event => patch({ threshold: Number(event.target.value) })}
              />
            </Field>
          </div>
        )}

        <Field label="Message" hint="What the approver is told this is about.">
          <Input value={draft.message} onChange={event => patch({ message: event.target.value })} />
        </Field>
      </div>

      <Notice kind="error" lines={error ? [error] : []} className="mt-3" />
    </Sheet>
  );
}

/* ------------------------------ the approvers ----------------------------- */

/**
 * Who a rule asks, and how many of them have to answer.
 *
 * The two quorums are the whole point of the list: one of three is a rota,
 * three of three is a board, and two of three is the arrangement neither of
 * those describes. They are separate numbers because rejection is usually the
 * cheaper quorum — a deal that needs two yeses very often needs only one no.
 *
 * Both are capped at the number of people asked, because a quorum larger than
 * the room could never be met and the quote would sit in review forever.
 */
function ApproverList({
  approvers,
  approvalsRequired,
  rejectionsRequired,
  directory,
  known,
  onChange,
}: {
  approvers: string[];
  approvalsRequired: number;
  rejectionsRequired: number;
  directory: DirectoryUser[];
  known: string[];
  onChange: (changes: Partial<ApprovalRuleInput>) => void;
}) {
  const [adding, setAdding] = useState("");

  /** Who has an account here, so a rule nobody can answer shows as one. */
  const accounts = new Map(directory.map(user => [user.email.toLowerCase(), user]));

  const add = (email: string) => {
    const address = email.trim().toLowerCase();
    setAdding("");
    if (!address || approvers.includes(address)) return;
    onChange({ approvers: [...approvers, address] });
  };

  const remove = (email: string) => {
    const next = approvers.filter(entry => entry !== email);
    onChange({
      approvers: next,
      // Keep the quorums inside the room as it shrinks.
      approvalsRequired: Math.min(approvalsRequired, Math.max(1, next.length)),
      rejectionsRequired: Math.min(rejectionsRequired, Math.max(1, next.length)),
    });
  };

  const total = approvers.length;

  /**
   * Everyone who could be added: the accounts on this instance, plus any
   * address the rules already name that has not registered yet.
   */
  const unused = [...new Set([...directory.map(user => user.email.toLowerCase()), ...known])]
    .filter(email => !approvers.includes(email))
    .sort()
    .map(email => {
      const account = accounts.get(email);
      return {
        value: email,
        label: email,
        hint: account?.name || undefined,
        badge: account ? undefined : "no account",
      };
    });

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Approvers</p>
        <p className="text-xs text-muted-foreground">
          Everyone here is asked at once. They see the quote this rule fired on, and nothing else of yours.
        </p>
      </div>

      {total === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          Nobody yet. A rule with no approver is skipped rather than blocking a quote forever.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {approvers.map(email => {
            const account = accounts.get(email);
            return (
              <li key={email} className="flex items-center gap-2 px-3 py-1.5">
                <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {account?.name ? `${account.name} · ${email}` : email}
                </span>
                {/* An approver with no account here can never answer, and the
                    quote would sit in review waiting for them. */}
                {directory.length > 0 && !account && <Badge tone="pending">no account</Badge>}
                <Button variant="ghost" size="icon-sm" onClick={() => remove(email)} aria-label={`Remove ${email}`}>
                  <Trash2 className="text-muted-foreground hover:text-destructive" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Combobox
        value={adding}
        onChange={add}
        options={unused}
        placeholder={directory.length ? "Add an approver" : "Add an approver by email"}
        allowCustom
        aria-label="Add an approver"
      />

      {total > 1 && (
        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Approvals needed" hint={quorumHint(approvalsRequired, total, "approve")}>
            <Input
              type="number"
              min={1}
              max={total}
              value={approvalsRequired}
              onChange={event =>
                onChange({ approvalsRequired: Math.min(Math.max(1, Number(event.target.value)), total) })
              }
            />
          </Field>
          <Field label="Rejections needed" hint={quorumHint(rejectionsRequired, total, "reject")}>
            <Input
              type="number"
              min={1}
              max={total}
              value={rejectionsRequired}
              onChange={event =>
                onChange({ rejectionsRequired: Math.min(Math.max(1, Number(event.target.value)), total) })
              }
            />
          </Field>
        </div>
      )}

      {total === 1 && (
        <p className="text-xs text-muted-foreground">
          With one approver their answer decides it. Add another to set how many must agree.
        </p>
      )}
    </div>
  );
}

/** "Any 1 of 3 approving carries it." — the sentence, not the arithmetic. */
function quorumHint(required: number, total: number, verb: "approve" | "reject"): string {
  const outcome = verb === "approve" ? "carries it" : "sends it back";
  if (required >= total) return `All ${total} must ${verb} before it ${outcome}.`;
  if (required === 1) return `Any one of the ${total} ${verb === "approve" ? "approving" : "rejecting"} ${outcome}.`;
  return `${required} of the ${total} must ${verb} before it ${outcome}.`;
}
