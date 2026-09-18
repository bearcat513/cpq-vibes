import { useState } from "react";
import { Building2, Check, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, Field, Notice, Section } from "./common";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { api } from "@/lib/api";
import { CURRENCIES, EMPTY_ADDRESS, type Account, type PriceBook } from "@/lib/types";
import type { AccountInput } from "@/lib/validate";

type Props = {
  accounts: Account[];
  priceBooks: PriceBook[];
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
  confirmed: (message: string) => boolean;
};

/**
 * Customers.
 *
 * An account carries the facts that are true of the customer rather than of
 * any one quote — their currency, their price book, their tax position, their
 * payment terms — and a new quote starts from them. A quote then keeps its own
 * copy, so changing an address here never rewrites a document already sent.
 */
export function AccountsView({ accounts, priceBooks, onChanged, onError, confirmed }: Props) {
  const [editing, setEditing] = useState<Account | null | undefined>(undefined);

  const remove = async (account: Account) => {
    if (!confirmed(`Delete ${account.name}? Quotes already written for them are kept.`)) return;
    try {
      await api.deleteAccount(account.id);
      await onChanged();
    } catch (error) {
      onError(error);
    }
  };

  return (
    <>
      <Section
        title="Customers"
        description={`${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
        actions={
          <Button size="sm" onClick={() => setEditing(null)}>
            <Plus /> New customer
          </Button>
        }
      >
        {accounts.length === 0 ? (
          <EmptyState title="No customers yet">
            A quote does not need one, but a proposal addressed to nobody is a hard document to send.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Contact</Th>
                <Th>Terms</Th>
                <Th numeric>Tax</Th>
                <Th numeric>Standing discount</Th>
                <Th className="w-20" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {accounts.map(account => (
                <Tr key={account.id}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{account.name}</span>
                      <Badge tone="outline">{account.currency}</Badge>
                      {account.taxExempt && <Badge tone="info">tax exempt</Badge>}
                    </div>
                    {account.industry && <p className="text-xs text-muted-foreground">{account.industry}</p>}
                  </Td>
                  <Td>
                    <span className="block text-sm">{account.contactName || "—"}</span>
                    <span className="text-xs text-muted-foreground">{account.contactEmail}</span>
                  </Td>
                  <Td className="text-muted-foreground">{account.paymentTerms || "—"}</Td>
                  <Td numeric className="text-muted-foreground">
                    {account.taxExempt ? "—" : `${account.taxPercent}%`}
                  </Td>
                  <Td numeric className="text-muted-foreground">
                    {account.defaultDiscountPercent ? `${account.defaultDiscountPercent}%` : "—"}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditing(account)} aria-label={`Edit ${account.name}`}>
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => void remove(account)}
                        aria-label={`Delete ${account.name}`}
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

      {editing !== undefined && (
        <AccountEditor
          account={editing}
          priceBooks={priceBooks}
          onSave={async input => {
            if (editing) await api.updateAccount(editing.id, input);
            else await api.createAccount(input);
            await onChanged();
            setEditing(undefined);
          }}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

const BLANK: AccountInput = {
  name: "",
  industry: "",
  website: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  billingAddress: { ...EMPTY_ADDRESS },
  currency: "USD",
  priceBookId: "",
  paymentTerms: "Net 30",
  defaultDiscountPercent: 0,
  taxExempt: false,
  taxPercent: 0,
  notes: "",
};

function AccountEditor({
  account,
  priceBooks,
  onSave,
  onClose,
}: {
  account: Account | null;
  priceBooks: PriceBook[];
  onSave: (input: AccountInput) => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<AccountInput>(() => {
    if (!account) return structuredClone(BLANK);
    const { id, ownerId, createdAt, updatedAt, ...rest } = account;
    return structuredClone(rest);
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = (changes: Partial<AccountInput>) => setDraft(current => ({ ...current, ...changes }));
  const address = (changes: Partial<AccountInput["billingAddress"]>) =>
    patch({ billingAddress: { ...draft.billingAddress, ...changes } });

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this customer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={account ? `Edit ${account.name}` : "New customer"}
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
          <Field label="Industry">
            <Input value={draft.industry} onChange={event => patch({ industry: event.target.value })} />
          </Field>
          <Field label="Website">
            <Input value={draft.website} onChange={event => patch({ website: event.target.value })} />
          </Field>
          <Field label="Payment terms">
            <Input value={draft.paymentTerms} onChange={event => patch({ paymentTerms: event.target.value })} />
          </Field>
        </div>

        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
          <Field label="Contact name">
            <Input value={draft.contactName} onChange={event => patch({ contactName: event.target.value })} />
          </Field>
          <Field label="Contact email">
            <Input type="email" value={draft.contactEmail} onChange={event => patch({ contactEmail: event.target.value })} />
          </Field>
          <Field label="Contact phone">
            <Input value={draft.contactPhone} onChange={event => patch({ contactPhone: event.target.value })} />
          </Field>
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Billing address</p>
          <div className="grid gap-2 @md:grid-cols-2">
            <Field label="Line 1">
              <Input value={draft.billingAddress.line1} onChange={event => address({ line1: event.target.value })} />
            </Field>
            <Field label="Line 2">
              <Input value={draft.billingAddress.line2} onChange={event => address({ line2: event.target.value })} />
            </Field>
            <Field label="City">
              <Input value={draft.billingAddress.city} onChange={event => address({ city: event.target.value })} />
            </Field>
            <Field label="State / region">
              <Input value={draft.billingAddress.state} onChange={event => address({ state: event.target.value })} />
            </Field>
            <Field label="Postal code">
              <Input value={draft.billingAddress.postalCode} onChange={event => address({ postalCode: event.target.value })} />
            </Field>
            <Field label="Country">
              <Input value={draft.billingAddress.country} onChange={event => address({ country: event.target.value })} />
            </Field>
          </div>
        </div>

        <div className="grid gap-3 @md:grid-cols-2">
          <Field label="Currency">
            <Select value={draft.currency} onValueChange={value => patch({ currency: value as AccountInput["currency"] })}>
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

          <Field label="Price book" hint="New quotes for this customer start here.">
            <Select
              value={draft.priceBookId || "default"}
              onValueChange={value => patch({ priceBookId: value === "default" ? "" : value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">The default book</SelectItem>
                {priceBooks.map(book => (
                  <SelectItem key={book.id} value={book.id}>
                    {book.name} ({book.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-3">
          <Field label="Tax exempt">
            <div className="flex h-9 items-center">
              <Switch checked={draft.taxExempt} onChange={event => patch({ taxExempt: event.target.checked })} />
            </div>
          </Field>
          <Field label="Tax %">
            <Input
              type="number"
              min={0}
              max={100}
              step="0.25"
              value={draft.taxPercent}
              onChange={event => patch({ taxPercent: Number(event.target.value) })}
              disabled={draft.taxExempt}
            />
          </Field>
          <Field label="Standing discount %">
            <Input
              type="number"
              min={0}
              max={100}
              value={draft.defaultDiscountPercent}
              onChange={event => patch({ defaultDiscountPercent: Number(event.target.value) })}
            />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea value={draft.notes} onChange={event => patch({ notes: event.target.value })} rows={3} />
        </Field>
      </div>

      <Notice kind="error" lines={error ? [error] : []} className="mt-3" />
    </Sheet>
  );
}
