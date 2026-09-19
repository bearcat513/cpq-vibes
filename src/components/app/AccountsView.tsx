import { useMemo, useState } from "react";
import { Building2, Check, Loader2, Pencil, Plus, Search, Star, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccountStatusBadge, EmptyState, Field, Notice, Section } from "./common";
import { CustomerDetail } from "./CustomerDetail";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { api } from "@/lib/api";
import { ACCOUNT_SORTS, accountTags, filterAccounts, sortAccounts, type AccountSort } from "@/lib/customers";
import type { Preferences } from "@/lib/preferences";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABELS,
  CONTACT_ROLES,
  CONTACT_ROLE_LABELS,
  CURRENCIES,
  EMPTY_ADDRESS,
  EMPTY_CONTACT,
  primaryContact,
  type Account,
  type AccountContact,
  type AccountStatus,
  type Address,
  type PriceBook,
} from "@/lib/types";
import { localId, MAX_CONTACTS, MAX_TAGS, type AccountInput } from "@/lib/validate";
import { cn } from "@/lib/utils";

type Props = {
  accounts: Account[];
  priceBooks: PriceBook[];
  preferences: Preferences;
  onChanged: () => Promise<void>;
  onError: (error: unknown) => void;
  onOpenQuote: (id: string) => void;
  /** Switches to the receivables screen, where an invoice can be acted on. */
  onOpenReceivables: () => void;
  confirmed: (message: string) => boolean;
};

/**
 * Customers.
 *
 * An account carries the facts that are true of the customer rather than of
 * any one quote — their currency, their price book, their tax position, their
 * payment terms, and everybody you deal with there — and a new quote starts
 * from them. A quote then keeps its own copy, so changing an address here
 * never rewrites a document already sent.
 *
 * The screen is a list until you pick one, and then it is that customer: the
 * same shape the quote editor uses, because a customer with a history is a
 * thing you read rather than a row you edit in place.
 */
export function AccountsView({
  accounts,
  priceBooks,
  preferences,
  onChanged,
  onError,
  onOpenQuote,
  onOpenReceivables,
  confirmed,
}: Props) {
  const [editing, setEditing] = useState<Account | null | undefined>(undefined);
  const [openId, setOpenId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AccountStatus | "">("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<AccountSort>("name");

  const tags = useMemo(() => accountTags(accounts), [accounts]);
  const counts = useMemo(() => {
    const tally = new Map<AccountStatus, number>();
    for (const account of accounts) tally.set(account.status, (tally.get(account.status) ?? 0) + 1);
    return tally;
  }, [accounts]);

  const visible = useMemo(
    () => sortAccounts(filterAccounts(accounts, { search, status, tag }), sort),
    [accounts, search, status, tag, sort],
  );

  const remove = async (account: Account) => {
    if (!confirmed(`Delete ${account.name}? Quotes already written for them are kept.`)) return;
    try {
      await api.deleteAccount(account.id);
      if (openId === account.id) setOpenId(null);
      await onChanged();
    } catch (error) {
      onError(error);
    }
  };

  const editor = editing !== undefined && (
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
  );

  // A customer deleted, or one whose id no longer resolves, falls back to the
  // list rather than to a blank screen.
  const open = openId ? (accounts.find(account => account.id === openId) ?? null) : null;

  if (open) {
    return (
      <>
        <CustomerDetail
          account={open}
          priceBooks={priceBooks}
          preferences={preferences}
          onBack={() => setOpenId(null)}
          onEdit={() => setEditing(open)}
          onOpenQuote={onOpenQuote}
          onOpenReceivables={onOpenReceivables}
          onError={onError}
        />
        {editor}
      </>
    );
  }

  return (
    <>
      <Section
        title="Customers"
        description={
          visible.length === accounts.length
            ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}`
            : `${visible.length} of ${accounts.length}`
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search"
                aria-label="Search customers"
                className="h-8 w-44 pl-8"
              />
            </div>

            {tags.length > 0 && (
              <Select value={tag || "all"} onValueChange={value => setTag(value === "all" ? "" : value)}>
                <SelectTrigger className="h-8 w-36" aria-label="Filter by tag">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any tag</SelectItem>
                  {tags.map(candidate => (
                    <SelectItem key={candidate} value={candidate}>
                      {candidate}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            <Select value={sort} onValueChange={value => setSort(value as AccountSort)}>
              <SelectTrigger className="h-8 w-40" aria-label="Sort customers">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_SORTS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button size="sm" onClick={() => setEditing(null)}>
              <Plus /> New customer
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap gap-1.5 border-b px-4 py-2">
          <FilterChip label="All" count={accounts.length} on={status === ""} onClick={() => setStatus("")} />
          {ACCOUNT_STATUSES.map(candidate => (
            <FilterChip
              key={candidate}
              label={ACCOUNT_STATUS_LABELS[candidate]}
              count={counts.get(candidate) ?? 0}
              on={status === candidate}
              onClick={() => setStatus(candidate)}
            />
          ))}
        </div>

        {visible.length === 0 ? (
          <EmptyState title={accounts.length ? "Nothing matches" : "No customers yet"}>
            {accounts.length
              ? "Try a different search, or clear the status and tag filters."
              : "A quote does not need one, but a proposal addressed to nobody is a hard document to send."}
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Primary contact</Th>
                <Th>Terms</Th>
                <Th numeric>Tax</Th>
                <Th numeric>Standing discount</Th>
                <Th className="w-20" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {visible.map(account => (
                <Tr
                  key={account.id}
                  onClick={() => setOpenId(account.id)}
                  className="cursor-pointer"
                  tabIndex={0}
                  onKeyDown={event => event.key === "Enter" && setOpenId(account.id)}
                >
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{account.name}</span>
                      <AccountStatusBadge status={account.status} />
                      <Badge tone="outline">{account.currency}</Badge>
                      {account.taxExempt && <Badge tone="info">tax exempt</Badge>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {account.industry && <p className="text-xs text-muted-foreground">{account.industry}</p>}
                      {account.tags.map(candidate => (
                        <Badge key={candidate} tone="neutral">
                          {candidate}
                        </Badge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    {account.contacts.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <span className="block text-sm">{primaryContact(account)?.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {primaryContact(account)?.email}
                          {account.contacts.length > 1 && ` · +${account.contacts.length - 1} more`}
                        </span>
                      </>
                    )}
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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={event => {
                          event.stopPropagation();
                          setEditing(account);
                        }}
                        aria-label={`Edit ${account.name}`}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={event => {
                          event.stopPropagation();
                          void remove(account);
                        }}
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

      {editor}
    </>
  );
}

function FilterChip({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      {label} <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

/* -------------------------------- editing -------------------------------- */

const BLANK: AccountInput = {
  name: "",
  industry: "",
  website: "",
  status: "prospect",
  tags: [],
  contacts: [],
  billingAddress: { ...EMPTY_ADDRESS },
  shippingAddress: { ...EMPTY_ADDRESS },
  shippingSameAsBilling: true,
  currency: "USD",
  priceBookId: "",
  paymentTerms: "Net 30",
  paymentTermDays: 30,
  creditLimit: 0,
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

  const address = (changes: Partial<Address>) => patch({ billingAddress: { ...draft.billingAddress, ...changes } });
  const shipTo = (changes: Partial<Address>) => patch({ shippingAddress: { ...draft.shippingAddress, ...changes } });

  /**
   * Turning "same as billing" off opens the form on the billing address
   * rather than on six empty boxes — a shipping address is nearly always the
   * billing one with a line or two changed. An address already typed is left
   * alone.
   */
  const setSameAsBilling = (same: boolean) => {
    const typed = Object.values(draft.shippingAddress).some(Boolean);
    patch({
      shippingSameAsBilling: same,
      shippingAddress: same || !typed ? { ...draft.billingAddress } : draft.shippingAddress,
    });
  };

  const contacts = (next: AccountContact[]) => patch({ contacts: next });

  const addContact = () =>
    contacts([
      ...draft.contacts,
      { ...EMPTY_CONTACT, id: localId("con"), primary: draft.contacts.length === 0 },
    ]);

  const patchContact = (id: string, changes: Partial<AccountContact>) =>
    contacts(draft.contacts.map(contact => (contact.id === id ? { ...contact, ...changes } : contact)));

  /** Exactly one primary, always — the same rule the server enforces. */
  const makePrimary = (id: string) =>
    contacts(draft.contacts.map(contact => ({ ...contact, primary: contact.id === id })));

  const removeContact = (id: string) => {
    const left = draft.contacts.filter(contact => contact.id !== id);
    if (left.length && !left.some(contact => contact.primary)) left[0]!.primary = true;
    contacts(left);
  };

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
          <Field label="Status" hint="Inactive keeps their history without keeping them in the list.">
            <Select value={draft.status} onValueChange={value => patch({ status: value as AccountStatus })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNT_STATUSES.map(candidate => (
                  <SelectItem key={candidate} value={candidate}>
                    {ACCOUNT_STATUS_LABELS[candidate]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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

        <TagEditor tags={draft.tags} onChange={next => patch({ tags: next })} />

        {/* ------------------------------ contacts ----------------------- */}

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Contacts</p>
              <p className="text-xs text-muted-foreground">
                The primary one is who a quote is addressed to. Its details are copied onto the quote when it is
                created.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={addContact}
              disabled={draft.contacts.length >= MAX_CONTACTS}
              aria-label="Add a contact"
            >
              <Plus /> Add
            </Button>
          </div>

          {draft.contacts.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">Nobody named yet.</p>
          ) : (
            <ul className="space-y-2">
              {draft.contacts.map(contact => (
                <li key={contact.id} className="space-y-2 rounded-md border bg-muted/30 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      variant={contact.primary ? "secondary" : "ghost"}
                      size="sm"
                      onClick={() => makePrimary(contact.id)}
                      aria-pressed={contact.primary}
                      aria-label={contact.primary ? `${contact.name} is the primary contact` : `Make ${contact.name} the primary contact`}
                    >
                      <Star className={cn(contact.primary && "fill-current")} />
                      {contact.primary ? "Primary" : "Make primary"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeContact(contact.id)}
                      aria-label={`Remove ${contact.name || "this contact"}`}
                    >
                      <Trash2 className="text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>

                  <div className="grid gap-2 @md:grid-cols-2">
                    <Field label="Name">
                      <Input
                        value={contact.name}
                        onChange={event => patchContact(contact.id, { name: event.target.value })}
                      />
                    </Field>
                    <Field label="Job title">
                      <Input
                        value={contact.title}
                        onChange={event => patchContact(contact.id, { title: event.target.value })}
                      />
                    </Field>
                    <Field label="Email">
                      <Input
                        type="email"
                        value={contact.email}
                        onChange={event => patchContact(contact.id, { email: event.target.value })}
                      />
                    </Field>
                    <Field label="Phone">
                      <Input
                        value={contact.phone}
                        onChange={event => patchContact(contact.id, { phone: event.target.value })}
                      />
                    </Field>
                    <Field label="What they are for">
                      <Select
                        value={contact.role}
                        onValueChange={value => patchContact(contact.id, { role: value as AccountContact["role"] })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONTACT_ROLES.map(role => (
                            <SelectItem key={role} value={role}>
                              {CONTACT_ROLE_LABELS[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ------------------------------ addresses ---------------------- */}

        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Billing address</p>
          <AddressFields address={draft.billingAddress} onChange={address} />
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Shipping address</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Same as billing
              <Switch
                checked={draft.shippingSameAsBilling}
                onChange={event => setSameAsBilling(event.target.checked)}
                aria-label="Ship to the billing address"
              />
            </label>
          </div>
          {draft.shippingSameAsBilling ? (
            <p className="text-xs text-muted-foreground">Anything shipped goes to the billing address above.</p>
          ) : (
            <AddressFields address={draft.shippingAddress} onChange={shipTo} />
          )}
        </div>

        {/* ------------------------------ commercial --------------------- */}

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

function AddressFields({ address, onChange }: { address: Address; onChange: (changes: Partial<Address>) => void }) {
  return (
    <div className="grid gap-2 @md:grid-cols-2">
      <Field label="Line 1">
        <Input value={address.line1} onChange={event => onChange({ line1: event.target.value })} />
      </Field>
      <Field label="Line 2">
        <Input value={address.line2} onChange={event => onChange({ line2: event.target.value })} />
      </Field>
      <Field label="City">
        <Input value={address.city} onChange={event => onChange({ city: event.target.value })} />
      </Field>
      <Field label="State / region">
        <Input value={address.state} onChange={event => onChange({ state: event.target.value })} />
      </Field>
      <Field label="Postal code">
        <Input value={address.postalCode} onChange={event => onChange({ postalCode: event.target.value })} />
      </Field>
      <Field label="Country">
        <Input value={address.country} onChange={event => onChange({ country: event.target.value })} />
      </Field>
    </div>
  );
}

/**
 * Tags, as chips.
 *
 * Enter and comma both commit one, because both are what people type, and a
 * tag committed on blur as well means a half-typed word is never silently
 * thrown away when the Save button is what took the focus.
 */
function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [typed, setTyped] = useState("");

  const commit = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    setTyped("");
    if (!tag || tags.includes(tag) || tags.length >= MAX_TAGS) return;
    onChange([...tags, tag].sort());
  };

  return (
    <Field label="Tags" hint="Your own segmentation — enterprise, emea, renewal-q3.">
      <div className="space-y-2">
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map(tag => (
              <span key={tag} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs">
                {tag}
                <button
                  type="button"
                  onClick={() => onChange(tags.filter(candidate => candidate !== tag))}
                  aria-label={`Remove the ${tag} tag`}
                  className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <Input
          value={typed}
          onChange={event => (event.target.value.includes(",") ? commit(event.target.value) : setTyped(event.target.value))}
          onKeyDown={event => {
            if (event.key !== "Enter") return;
            // Enter in a tag box adds a tag; it must not submit the panel.
            event.preventDefault();
            commit(typed);
          }}
          onBlur={() => commit(typed)}
          placeholder={tags.length >= MAX_TAGS ? `${MAX_TAGS} is the limit` : "Add a tag"}
          disabled={tags.length >= MAX_TAGS}
          aria-label="Add a tag"
        />
      </div>
    </Field>
  );
}
