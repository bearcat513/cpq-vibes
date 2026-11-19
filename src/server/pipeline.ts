/**
 * The pipeline: saving opportunities, converting leads, and quoting a deal.
 *
 * The domain is src/lib/pipeline.ts; this decides what a write does to the
 * records around it. Access is still PocketBase's — every read and write is
 * the caller's own — and the checks here exist to refuse early, with a
 * sentence, what the collection rules would refuse anyway:
 *
 * - **An opportunity is with a customer the caller can read**, and its contact
 *   is one of that customer's.
 * - **`closedAt` is the server's.** Stamped when a deal enters a closed stage,
 *   kept while it stays closed, cleared if it is reopened.
 * - **Converting is one batch** (`convertLeadRecords`): the customer, the
 *   contact, the opportunity and the lead's own "converted" land together.
 *   Permissions are checked before the first write rather than discovered
 *   halfway through, the way a sample install is.
 * - **A quote for an opportunity is for its customer** — checked by
 *   `resolveQuoteOpportunity` in src/server/quotes.ts, on every create and
 *   save that names one.
 */
import { addDaysTo, today } from "../lib/clock";
import { canEditOpportunity } from "../lib/organization";
import {
  DEFAULT_CLOSE_DAYS,
  defaultOpportunityName,
  isClosedStage,
  isConverted,
  leadAccountName,
  probabilityFor,
  type Lead,
  type Opportunity,
} from "../lib/pipeline";
import { paymentTermsLabel } from "../lib/preferences";
import type { Account, AccountContact } from "../lib/types";
import {
  MAX_CONTACTS,
  readAccount,
  readQuoteHeader,
  type LeadConversionInput,
  type OpportunityInput,
} from "../lib/validate";
import { currentContext, requirePermission } from "./context";
import {
  convertLeadRecords,
  createOpportunity,
  getAccount,
  getLead,
  getOpportunity,
  updateOpportunity,
  type OpportunityRecordInput,
} from "./db";
import { ApiError } from "./http";
import { readPreferences } from "./preferences";
import { createPricedQuote, type CreateQuoteResult } from "./quotes";

const NO_ACCOUNT = "That customer does not exist, or is not in your organization.";

async function readableAccount(token: string, id: string): Promise<Account> {
  const account = await getAccount(token, id);
  if (!account) throw new ApiError(NO_ACCOUNT, 404);
  return account;
}

/** `closedAt` after a write: kept while closed, stamped on closing, cleared on reopening. */
function closedAtFor(stage: Opportunity["stage"], existing: Opportunity | null): string {
  if (!isClosedStage(stage)) return "";
  if (existing && isClosedStage(existing.stage) && existing.closedAt) return existing.closedAt;
  return new Date().toISOString();
}

/* ------------------------------ opportunities ----------------------------- */

/**
 * Creates (`id` null) or replaces an opportunity. A deal closed with no close
 * date is dated today — the day it closed is the one fact about it nobody
 * will argue with.
 */
export async function saveOpportunity(token: string, id: string | null, input: OpportunityInput): Promise<Opportunity> {
  const account = await readableAccount(token, input.accountId);
  if (input.contactId && !account.contacts.some(contact => contact.id === input.contactId)) {
    throw new ApiError(`That contact is not one of ${account.name}'s.`);
  }

  const existing = id ? await getOpportunity(token, id) : null;
  if (id && !existing) throw new ApiError("Opportunity not found.", 404);

  const context = currentContext();
  if (existing && context && !canEditOpportunity(context.role, existing, { id: context.user.id, orgId: context.org?.id })) {
    throw new ApiError("Only the opportunity's owner, or an admin, can change it.", 403);
  }

  const record: OpportunityRecordInput = {
    ...input,
    closeDate: input.closeDate || (isClosedStage(input.stage) ? today() : ""),
    closedAt: closedAtFor(input.stage, existing),
  };

  if (!id) return createOpportunity(token, record);
  const saved = await updateOpportunity(token, id, record);
  if (!saved) throw new ApiError("Opportunity not found, or not yours to change.", 404);
  return saved;
}

/**
 * A new draft quote for an opportunity: its customer, its currency, its name,
 * and no lines yet — the rep picks those in the editor. Numbered, priced and
 * stored exactly as `POST /api/quotes` would, because it *is* that.
 */
export async function quoteOpportunity(token: string, id: string): Promise<CreateQuoteResult> {
  requirePermission("quotes.create", "create a quote");
  const opportunity = await getOpportunity(token, id);
  if (!opportunity) throw new ApiError("Opportunity not found.", 404);
  if (isClosedStage(opportunity.stage)) {
    throw new ApiError("This opportunity is closed. Reopen it before quoting it again.", 409);
  }

  const preferences = await readPreferences(token);
  const header = readQuoteHeader({
    name: opportunity.name,
    accountId: opportunity.accountId,
    opportunityId: opportunity.id,
    currency: opportunity.currency,
    termMonths: preferences.defaultTermMonths,
    priceBookId: preferences.defaultPriceBookId,
  });
  if (!header.ok) throw new ApiError(header.error);
  return createPricedQuote(token, header.value, [], preferences.quoteValidDays);
}

/* ---------------------------------- leads --------------------------------- */

export type LeadConversion = { lead: Lead; account: Account; opportunity: Opportunity | null };

/** The lead's person, as a contact on a customer — or null when the lead names only a company. */
function leadContact(lead: Lead, primary: boolean): AccountContact | null {
  if (!lead.name) return null;
  return { id: "", name: lead.name, title: lead.title, email: lead.email, phone: lead.phone, role: "commercial", primary };
}

/**
 * Converts a lead.
 *
 * Into a new customer, named after its company (or its person), in its
 * currency, on the organization's default payment terms — or onto an existing
 * one, where the person is added as a contact unless somebody with that email
 * is already there. Then an opportunity, unless asked not to: amount from the
 * lead's estimate when it is in the customer's currency (never converted from
 * another — see pipeline.ts), closing in `DEFAULT_CLOSE_DAYS` unless dated.
 */
export async function convertLead(token: string, id: string, input: LeadConversionInput): Promise<LeadConversion> {
  requirePermission("leads.write", "convert a lead");
  if (!input.accountId) requirePermission("accounts.write", "create a customer");
  if (input.createOpportunity) requirePermission("opportunities.create", "open an opportunity");

  const lead = await getLead(token, id);
  if (!lead) throw new ApiError("Lead not found.", 404);
  if (isConverted(lead)) throw new ApiError("This lead has already been converted.", 409);

  const existing = input.accountId ? await readableAccount(token, input.accountId) : null;

  // The person: always onto a new customer; onto an existing one only if asked,
  // only once, and only while there is room.
  const sameEmail = existing && lead.email ? existing.contacts.find(contact => contact.email === lead.email) : undefined;
  const person =
    !existing || (input.addContact && !sameEmail && existing.contacts.length < MAX_CONTACTS)
      ? leadContact(lead, !existing || existing.contacts.length === 0)
      : null;

  let newAccount = null;
  if (!existing) {
    const preferences = await readPreferences(token);
    const account = readAccount({
      name: leadAccountName(lead),
      industry: lead.industry,
      website: lead.website,
      status: "prospect",
      currency: lead.currency,
      paymentTerms: paymentTermsLabel(preferences.defaultPaymentTermDays),
      paymentTermDays: preferences.defaultPaymentTermDays,
      taxPercent: preferences.defaultTaxPercent,
      notes: lead.notes,
      contacts: [],
    });
    if (!account.ok) throw new ApiError(account.error);
    newAccount = account.value;
  }

  const currency = existing?.currency ?? lead.currency;
  const stage = input.opportunity.stage;
  const opportunity: OpportunityRecordInput | null = input.createOpportunity
    ? {
        name: input.opportunity.name || defaultOpportunityName(lead),
        // Filled in by convertLeadRecords once the account's id is known.
        accountId: "",
        contactId: sameEmail?.id ?? "",
        stage,
        amount: input.opportunity.amount ?? (lead.currency === currency ? lead.estimatedAmount : 0),
        currency,
        probability: probabilityFor(stage, null),
        closeDate: input.opportunity.closeDate || (isClosedStage(stage) ? today() : addDaysTo(today(), DEFAULT_CLOSE_DAYS)),
        source: lead.source,
        nextStep: "",
        lossReason: "",
        notes: "",
        closedAt: isClosedStage(stage) ? new Date().toISOString() : "",
        leadId: lead.id,
      }
    : null;

  const ids = await convertLeadRecords(token, {
    leadId: lead.id,
    newAccount,
    existingAccountId: existing?.id ?? null,
    contact: person ? { contact: person, position: existing?.contacts.length ?? 0 } : null,
    opportunity,
    convertedAt: new Date().toISOString(),
  });

  const [convertedLead, account, opened] = await Promise.all([
    getLead(token, lead.id),
    getAccount(token, ids.accountId),
    ids.opportunityId ? getOpportunity(token, ids.opportunityId) : Promise.resolve(null),
  ]);
  if (!convertedLead || !account) throw new ApiError("The lead was converted but could not be read back.", 502);
  return { lead: convertedLead, account, opportunity: opened };
}
