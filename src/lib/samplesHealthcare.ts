/**
 * A second worked example: a healthcare data-archiving catalogue, from the
 * workbook in `tools/Example Products and Pricing Template - Revamped.xlsx`.
 *
 * Every price is the workbook's own, and the workbook calls them illustrative.
 * The customers are fictional. What the workbook does not give, this file has
 * to supply, and says so where it does: `Price source` on a product whose
 * prices were derived, and `COST_RATIO` for what everything costs to deliver.
 *
 * ## How the workbook's pricing models land on this engine
 *
 * - **Block** (a flat price for a bed or provider range) is a required
 *   single-select option group. A tier cannot do it: a tier sets a *unit*
 *   price, and a block is the same money at 26 beds as at 100. Quantity is 1.
 * - **Percent of license** is a unit price of `0.18` and a quantity of the
 *   dollars it is a percentage of, so the line prints its own arithmetic and
 *   discounts, rules and contract rates all work unchanged. The quantity does
 *   not follow the other lines if a rep changes them.
 * - **Hot Storage's tiers are pricing rules using `min()`**, not volume tiers.
 *   An `override` tier replaces the price book's price, so a contracted $240
 *   would come back out at $325 on a small order.
 * - **A subsystem is its own product**, not a bundle component: a component
 *   is added at quantity 1 with no options, which would price every subsystem
 *   at the smallest band and every percent line at eighteen cents.
 *
 * Dependencies between products (ROI requires Hot Storage) have no home in a
 * product rule, which only sees its own options, so they are stated in
 * `attributes`. The discounts that depend on a fact about the customer rather
 * than the line (facility type, payment terms, partner referral) cannot be
 * rules either, because a rule sees no customer, so the sample quotes apply
 * them as ordinary discounts.
 */
import { addDays, today as todayIso } from "./receivable";
import type { LeadSource, OpportunityStage } from "./pipeline";
import type { SampleInvoice } from "./samples";
import type { OptionGroup } from "./types";
import type { AccountInput, ApprovalRuleInput, PriceBookInput, PricingRuleInput, ProductInput } from "./validate";

/* --------------------------------- helpers -------------------------------- */

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** The workbook has no costs. These are invented so margin reads as something. */
const COST_RATIO = { license: 0.15, service: 0.55, support: 0.3, hosting: 0.5 } as const;

const costOf = (price: number, ratio: number) => Math.round(price * ratio * 100) / 100;

/** A subsystem's share of its parent's block, as TruBridge's own lines price it. */
const SUBSYSTEM_SHARE = 0.45;

type Band = { max: number | null; price: number };

const bandsOf = (prices: number[], maxima: (number | null)[]): Band[] =>
  prices.map((price, index) => ({ price, max: maxima[index] ?? null }));

const BED_RANGES = [25, 100, 300, 600, null];
const PROVIDER_RANGES = [10, 50, 150, null];

/**
 * The block table, as options priced relative to the smallest band. That band
 * is the product's list price, so the catalogue reads "from $18,000".
 */
function bandGroup(unit: "bed" | "provider", bands: Band[]): OptionGroup {
  const label = unit === "bed" ? "Licensed beds" : "Licensed providers";
  return {
    id: `grp_${unit}s`,
    key: `${unit}s`,
    name: label,
    description: "A flat price for the range, not a price per unit. Quantity stays at 1.",
    select: "one",
    required: true,
    options: bands.map((band, index) => {
      const min = index === 0 ? 1 : (bands[index - 1]!.max as number) + 1;
      const range = band.max === null ? `${min}+` : `${min}-${band.max}`;
      const delta = band.price - bands[0]!.price;
      return {
        id: `opt_${unit}_${min}`,
        key: `${unit}_${min}`,
        name: `${range} ${unit}s`,
        description: "",
        priceDelta: delta,
        priceFactor: 1,
        costDelta: costOf(delta, COST_RATIO.license),
        default: index === 0,
      };
    }),
  };
}

/** A configuration question from the workbook: no price, just the answer on the line. */
function picklist(name: string, values: string[], required = false): OptionGroup {
  const key = slug(name);
  return {
    id: `grp_${key}`,
    key,
    name,
    description: "",
    select: "one",
    required,
    options: values.map((value, index) => ({
      id: `opt_${key}_${slug(value)}`,
      key: `${key}_${slug(value)}`,
      name: value,
      description: "",
      priceDelta: 0,
      priceFactor: 1,
      costDelta: 0,
      default: required && index === 0,
    })),
  };
}

/** The questions every archive license asks. */
const archiveQuestions = (): OptionGroup[] => [
  picklist("Facility type", [
    "Acute Hospital",
    "Critical Access Hospital",
    "Physician Group",
    "FQHC",
    "ASC",
    "Post-Acute/SNF",
    "Behavioral Health",
    "Lab",
  ]),
  picklist("Retention", ["7 Years", "10 Years", "21 Years (Minors)", "25 Years", "Permanent"]),
  picklist("Source hosting", ["On-Premise", "Vendor-Hosted", "Third-Party Cloud"]),
];

const ARCHIVE = "HealthData Platform - Archive";
const ADD_ONS = "HealthData Platform - Add-ons";
const SERVICES = "Data Services";
const SUPPORT = "Support";
const HOSTING = "Legacy Data Management";

const DERIVED_PRICE = `Derived: the workbook has no price lines here, so ${SUBSYSTEM_SHARE * 100}% of the parent's block`;
const DERIVED_TABLE = "Derived: the workbook has no price lines here, so the table its ambulatory siblings share";

type Common = Pick<ProductInput, "sku" | "name" | "description" | "family"> &
  Partial<Pick<ProductInput, "minQuantity" | "maxQuantity" | "floorDiscountPercent" | "optionGroups" | "attributes" | "billingPeriod" | "chargeType" | "unitOfMeasure">>;

function product(common: Common, listPrice: number, ratio: number): ProductInput {
  return {
    chargeType: "one-time",
    billingPeriod: "monthly",
    unitOfMeasure: "each",
    minQuantity: 1,
    maxQuantity: 0,
    floorDiscountPercent: 15,
    optionGroups: [],
    attributes: {},
    ...common,
    listPrice,
    cost: costOf(listPrice, ratio),
    currency: "USD",
    active: true,
    rules: [],
    components: [],
    volumeTiers: [],
  };
}

/** A parent system or a subsystem priced by a block table. */
function blockLicense(
  common: Common & { unit: "bed" | "provider"; prices: number[]; questions?: OptionGroup[] },
): ProductInput {
  const { unit, prices, questions = [], ...rest } = common;
  const ranges = unit === "bed" ? BED_RANGES : PROVIDER_RANGES;
  return product(
    {
      unitOfMeasure: "license",
      maxQuantity: 1,
      ...rest,
      optionGroups: [bandGroup(unit, bandsOf(prices, ranges)), ...questions],
    },
    prices[0]!,
    COST_RATIO.license,
  );
}

/** Priced as a share of some other number: the quantity is that number. */
function percentOf(common: Common, share: number, ratio: number, basis: string): ProductInput {
  return product(
    {
      unitOfMeasure: `$ of ${basis}`,
      ...common,
      attributes: { "Quantity": `The ${basis} total in dollars`, ...common.attributes },
    },
    share,
    ratio,
  );
}

const share = (prices: number[]) => prices.map(price => price * SUBSYSTEM_SHARE);

/** A parent system, with the subsystems that price off its own block table. */
const PRICES = {
  trubridge: [18_000, 42_000, 78_000, 125_000, 185_000],
  meditech: [18_000, 42_000, 78_000, 125_000, 185_000],
  oracle: [20_700, 48_300, 89_700, 143_800, 212_700],
  epic: [21_600, 50_400, 93_600, 150_000, 222_000],
  ambulatory: [9_500, 24_000, 52_000, 88_000],
};

const seRequired = { "SE required": "Yes" };

/* -------------------------------- products -------------------------------- */

export const HEALTHCARE_PRODUCTS: ProductInput[] = [
  /* TruBridge */
  blockLicense({
    sku: "ARC-TBR-CPSI",
    name: "TruBridge (CPSI) Archive",
    description: "Active archive license for legacy TruBridge/CPSI EHR data; read-only clinical and financial record access after system sunset.",
    family: ARCHIVE,
    unit: "bed",
    prices: PRICES.trubridge,
    questions: archiveQuestions(),
    attributes: { ...seRequired, "Care setting": "Acute" },
  }),
  blockLicense({
    sku: "ARC-TBR-CPSI-CLN",
    name: "TruBridge (CPSI) - Clinical",
    description: "Clinical subsystem: encounters, orders, results, MAR, notes, problem/allergy lists.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.trubridge),
    attributes: { "Parent system": "ARC-TBR-CPSI", "Price source": "301+ beds derived: the workbook stops at 300" },
  }),
  blockLicense({
    sku: "ARC-TBR-CPSI-RCM",
    name: "TruBridge (CPSI) - Revenue Cycle",
    description: "Revenue cycle subsystem: patient accounts, charges, claims, remits, transaction history.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.trubridge),
    attributes: { "Parent system": "ARC-TBR-CPSI", "Price source": "301+ beds derived: the workbook stops at 300" },
  }),
  percentOf(
    {
      sku: "ARC-TBR-CPSI-HRP",
      name: "TruBridge (CPSI) - HR/Payroll",
      description: "HR/Payroll subsystem: employee master, pay history, W-2s, benefits deductions.",
      family: ARCHIVE,
      attributes: { "Parent system": "ARC-TBR-CPSI" },
    },
    0.15,
    COST_RATIO.license,
    "parent license",
  ),
  percentOf(
    {
      sku: "ARC-TBR-CPSI-APGL",
      name: "TruBridge (CPSI) - AP/GL",
      description: "Accounts payable and general ledger subsystem: vendors, invoices, checks, journal entries.",
      family: ARCHIVE,
      attributes: { "Parent system": "ARC-TBR-CPSI" },
    },
    0.12,
    COST_RATIO.license,
    "parent license",
  ),

  /* MEDITECH */
  blockLicense({
    sku: "ARC-MTX",
    name: "MEDITECH Archive",
    description: "Active archive license for legacy MEDITECH MAGIC, Client/Server, or 6.x data.",
    family: ARCHIVE,
    unit: "bed",
    prices: PRICES.meditech,
    questions: [picklist("MEDITECH platform", ["MAGIC", "Client/Server", "6.x", "Expanse"], true), ...archiveQuestions()],
    attributes: { ...seRequired, "Care setting": "Acute", "Platform review": "Expanse requires SE review" },
  }),
  blockLicense({
    sku: "ARC-MTX-CLN",
    name: "MEDITECH - Clinical",
    description: "Clinical subsystem: EMR, PCS, OE, LAB, RAD, PHA historical records.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.meditech),
    attributes: { "Parent system": "ARC-MTX", "Price source": DERIVED_PRICE },
  }),
  blockLicense({
    sku: "ARC-MTX-RCM",
    name: "MEDITECH - Revenue Cycle",
    description: "B/AR, ABS, and MRI financial history including itemized bills and payment detail.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.meditech),
    attributes: { "Parent system": "ARC-MTX", "Price source": DERIVED_PRICE },
  }),
  percentOf(
    {
      sku: "ARC-MTX-HRP",
      name: "MEDITECH - HR/Payroll",
      description: "PP/HR employee and payroll history.",
      family: ARCHIVE,
      attributes: { "Parent system": "ARC-MTX" },
    },
    0.15,
    COST_RATIO.license,
    "parent license",
  ),

  /* Oracle Health */
  blockLicense({
    sku: "ARC-ORH",
    name: "Oracle Health (Cerner) Millennium Archive",
    description: "Active archive license for legacy Oracle Health (Cerner) Millennium data after EHR conversion.",
    family: ARCHIVE,
    unit: "bed",
    prices: PRICES.oracle,
    questions: archiveQuestions(),
    attributes: { ...seRequired, "Care setting": "Acute" },
  }),
  blockLicense({
    sku: "ARC-ORH-CLN",
    name: "Oracle Health (Cerner) - Clinical",
    description: "PowerChart clinical documentation, orders, results, and flowsheets.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.oracle),
    attributes: { "Parent system": "ARC-ORH", "Price source": DERIVED_PRICE },
  }),
  blockLicense({
    sku: "ARC-ORH-PA",
    name: "Oracle Health (Cerner) - Patient Accounting",
    description: "Patient Accounting (ProFit/RevElate) encounters, charges, claims, and balances.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.oracle),
    attributes: { "Parent system": "ARC-ORH", "Price source": DERIVED_PRICE },
  }),

  /* Epic */
  blockLicense({
    sku: "ARC-EPC",
    name: "Epic Archive",
    description: "Active archive license for a retired Epic instance (e.g., post-merger consolidation).",
    family: ARCHIVE,
    unit: "bed",
    prices: PRICES.epic,
    questions: [picklist("Epic data source", ["Clarity", "Chronicles", "Both"], true), ...archiveQuestions()],
    attributes: { ...seRequired, "Care setting": "Acute", "Source review": "Chronicles requires SE review" },
  }),
  blockLicense({
    sku: "ARC-EPC-CLN",
    name: "Epic - Clinical",
    description: "Clarity/Chronicles clinical data: encounters, notes, results, medications, media.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.epic),
    attributes: { "Parent system": "ARC-EPC", "Price source": DERIVED_PRICE },
  }),
  blockLicense({
    sku: "ARC-EPC-RES",
    name: "Epic - Resolute HB/PB",
    description: "Hospital and professional billing history for A/R wind down and audits.",
    family: ARCHIVE,
    unit: "bed",
    prices: share(PRICES.epic),
    attributes: { "Parent system": "ARC-EPC", "Price source": DERIVED_PRICE },
  }),

  /* Ambulatory */
  blockLicense({
    sku: "ARC-ECW",
    name: "eClinicalWorks Archive",
    description: "Active archive license for legacy eClinicalWorks ambulatory EHR/PM data.",
    family: ARCHIVE,
    unit: "provider",
    prices: PRICES.ambulatory,
    questions: archiveQuestions(),
    attributes: { "Care setting": "Ambulatory" },
  }),
  blockLicense({
    sku: "ARC-ECW-EHR",
    name: "eClinicalWorks - EHR",
    description: "Progress notes, labs, medications, immunizations, documents.",
    family: ARCHIVE,
    unit: "provider",
    prices: share(PRICES.ambulatory),
    attributes: { "Parent system": "ARC-ECW", "Price source": DERIVED_PRICE },
  }),
  blockLicense({
    sku: "ARC-ECW-PM",
    name: "eClinicalWorks - Practice Management",
    description: "Appointments, claims, payments, patient ledgers.",
    family: ARCHIVE,
    unit: "provider",
    prices: share(PRICES.ambulatory),
    attributes: { "Parent system": "ARC-ECW", "Price source": DERIVED_PRICE },
  }),
  blockLicense({
    sku: "ARC-ATH",
    name: "athenahealth Archive",
    description: "Active archive license for legacy athenaOne clinicals and collector data.",
    family: ARCHIVE,
    unit: "provider",
    prices: PRICES.ambulatory,
    questions: archiveQuestions(),
    attributes: { "Care setting": "Ambulatory" },
  }),
  blockLicense({
    sku: "ARC-NXG",
    name: "NextGen Enterprise Archive",
    description: "Active archive license for legacy NextGen Enterprise EHR/PM and Dental data.",
    family: ARCHIVE,
    unit: "provider",
    prices: PRICES.ambulatory,
    questions: [picklist("Includes dental", ["No", "Yes"], true), ...archiveQuestions()],
    attributes: { "Care setting": "Ambulatory" },
  }),
  blockLicense({
    sku: "ARC-GRW",
    name: "Greenway Intergy Archive",
    description: "Active archive license for legacy Greenway Intergy/Prime Suite data.",
    family: ARCHIVE,
    unit: "provider",
    prices: PRICES.ambulatory,
    questions: archiveQuestions(),
    attributes: { "Care setting": "Ambulatory", "Price source": DERIVED_TABLE },
  }),

  /* ERP */
  product(
    {
      sku: "ARC-LAW",
      name: "Infor Lawson ERP Archive",
      description: "Archive license for legacy Lawson financials, supply chain, and HR data. Includes Financials and Supply Chain.",
      family: ARCHIVE,
      unitOfMeasure: "system",
      maxQuantity: 1,
      optionGroups: archiveQuestions(),
      attributes: { ...seRequired, "Care setting": "Finance/HR" },
    },
    65_000,
    COST_RATIO.license,
  ),
  percentOf(
    {
      sku: "ARC-LAW-HRP",
      name: "Infor Lawson - HR/Payroll",
      description: "Employee, payroll, and benefits history (I-9, W-2, pay stubs).",
      family: ARCHIVE,
      attributes: { "Parent system": "ARC-LAW" },
    },
    0.25,
    COST_RATIO.license,
    "parent license",
  ),
  percentOf(
    {
      sku: "ARC-LAW-APGL",
      name: "Infor Lawson - AP/GL",
      description: "AP invoices, vendor master, GL balances, and journal history.",
      family: ARCHIVE,
      attributes: { "Parent system": "ARC-LAW" },
    },
    0.2,
    COST_RATIO.license,
    "parent license",
  ),

  /* Add-ons */
  product(
    {
      sku: "ADD-ARM",
      name: "HealthData AR Manager",
      description: "Advanced A/R wind down workspace: work queues, payment posting, claim rebilling, and balance reporting against archived accounts.",
      family: ADD_ONS,
      chargeType: "recurring",
      billingPeriod: "annual",
      unitOfMeasure: "subscription",
      maxQuantity: 1,
      optionGroups: [
        bandGroup("bed", bandsOf([24_000, 48_000, 84_000], [100, 300, null])),
        picklist("Wind-down duration", ["6 months", "12 months", "18 months", "24 months"], true),
      ],
      attributes: { ...seRequired, Requires: "A Revenue Cycle, Patient Accounting or Resolute subsystem" },
    },
    24_000,
    COST_RATIO.license,
  ),
  product(
    {
      sku: "ADD-ROI",
      name: "Release of Information (ROI) Module",
      description: "Request tracking, compliant disclosure packets, and audit logging for archived records.",
      family: ADD_ONS,
      chargeType: "recurring",
      billingPeriod: "annual",
      unitOfMeasure: "archive",
      maxQuantity: 1,
      optionGroups: [picklist("ROI partner", ["Datavant (Ciox)", "MRO", "Verisma", "In-House"], true)],
      attributes: { Requires: "HST-HOT" },
    },
    9_600,
    COST_RATIO.license,
  ),
  product(
    {
      sku: "ADD-CTX",
      name: "EHR Context Launch Integration",
      description: "SSO/context-aware launch from the active EHR into the archived patient record.",
      family: ADD_ONS,
      unitOfMeasure: "target EHR",
      maxQuantity: 10,
      attributes: { ...seRequired, Requires: "HST-HOT" },
    },
    12_500,
    COST_RATIO.license,
  ),
  product(
    {
      sku: "MCO-PLT",
      name: "Managed Care Oversight",
      description: "Configurable delegated-entity oversight workflows by state with compliance reporting.",
      family: "Data Solutions",
      chargeType: "recurring",
      billingPeriod: "annual",
      unitOfMeasure: "state",
      attributes: { ...seRequired, "Care setting": "Payer" },
    },
    36_000,
    COST_RATIO.license,
  ),

  /* Services */
  product(
    {
      sku: "SVC-EXT-STD",
      name: "Data Extraction - Standard",
      description: "Extraction of a supported legacy system using an established HHIT extraction method.",
      family: SERVICES,
      unitOfMeasure: "source system",
      optionGroups: [picklist("Extraction method", ["Database Direct", "Vendor API", "Report-Based", "Flat File"], true)],
      attributes: { Billing: "50% at kickoff, 50% at extract acceptance", Excludes: "SVC-EXT-CPX for the same system" },
    },
    22_500,
    COST_RATIO.service,
  ),
  product(
    {
      sku: "SVC-EXT-CPX",
      name: "Data Extraction - Complex",
      description: "Custom extraction for unsupported, vendor-hosted, or proprietary-format systems.",
      family: SERVICES,
      unitOfMeasure: "hour",
      minQuantity: 40,
      attributes: { ...seRequired, Billing: "Monthly in arrears" },
    },
    225,
    COST_RATIO.service,
  ),
  product(
    {
      sku: "SVC-MIG",
      name: "Data Migration/Conversion",
      description: "Mapping, transformation, and load of legacy data into the customer's new EHR/ERP.",
      family: SERVICES,
      unitOfMeasure: "data domain",
      optionGroups: [
        picklist("Target system", ["Epic", "Oracle Health", "MEDITECH Expanse", "athenaOne", "eClinicalWorks", "NextGen", "Workday", "Other"], true),
      ],
      attributes: { ...seRequired, Billing: "Milestone" },
    },
    35_000,
    COST_RATIO.service,
  ),
  percentOf(
    {
      sku: "SVC-IMP",
      name: "Archive Implementation & Validation",
      description: "Configuration, data load, reconciliation, and user acceptance support for an archive.",
      family: SERVICES,
      attributes: { Billing: "Milestone" },
    },
    0.3,
    COST_RATIO.service,
    "quote license",
  ),
  percentOf(
    {
      sku: "SVC-PM",
      name: "Project Management",
      description: "Dedicated HHIT project manager for multi-system or migration engagements. Expected once services pass $50,000.",
      family: SERVICES,
      attributes: { Billing: "Milestone" },
    },
    0.12,
    COST_RATIO.service,
    "quote services",
  ),
  product(
    {
      sku: "SVC-DOC",
      name: "Scanned Document & Image Migration",
      description: "Migration of scanned documents, PDFs, and non-DICOM images into the archive.",
      family: SERVICES,
      unitOfMeasure: "million pages",
      attributes: { Billing: "Milestone" },
    },
    4_500,
    COST_RATIO.service,
  ),
  product(
    {
      sku: "SVC-CRB",
      name: "Custom Report/View Build",
      description: "Custom archive views, reports, or extract formats beyond the standard viewer.",
      family: SERVICES,
      unitOfMeasure: "hour",
      minQuantity: 8,
      attributes: { Billing: "Monthly in arrears" },
    },
    195,
    COST_RATIO.service,
  ),

  /* Support */
  percentOf(
    {
      sku: "SUP-STD",
      name: "Annual Support & Maintenance - Standard",
      description: "Business-hours support, software updates, and security patching.",
      family: SUPPORT,
      chargeType: "recurring",
      billingPeriod: "annual",
      attributes: { Billing: "Year 1 billed at go-live", Excludes: "SUP-PRM" },
    },
    0.18,
    COST_RATIO.support,
    "quote license",
  ),
  percentOf(
    {
      sku: "SUP-PRM",
      name: "Annual Support & Maintenance - Premium",
      description: "24x7 support with 1-hour P1 response and named customer success manager.",
      family: SUPPORT,
      chargeType: "recurring",
      billingPeriod: "annual",
      attributes: { Excludes: "SUP-STD" },
    },
    0.22,
    COST_RATIO.support,
    "quote license",
  ),

  /* Hosting */
  product(
    {
      sku: "HST-HOT",
      name: "Hot Storage - Active Archive",
      description: "HITRUST-certified hosting for archives requiring frequent clinical, ROI, and A/R access.",
      family: HOSTING,
      chargeType: "recurring",
      unitOfMeasure: "TB",
      // The published rate falls 31% across the tiers, and that is not a
      // discount anybody needs to sign for.
      floorDiscountPercent: 40,
      optionGroups: [picklist("Hosting region", ["US-East", "US-Central", "US-West"], true)],
    },
    325,
    COST_RATIO.hosting,
  ),
  product(
    {
      sku: "HST-WRM",
      name: "Warm Storage - HealthData Locker Tier 3",
      description: "Secure storage for business-critical data needing occasional access; upload, download, delete.",
      family: HOSTING,
      chargeType: "recurring",
      unitOfMeasure: "TB",
    },
    110,
    COST_RATIO.hosting,
  ),
  product(
    {
      sku: "HST-CLD-T2",
      name: "Cold Storage - HealthData Locker Tier 2",
      description: "Long-term compliant preservation with retrieval on request (standard retrieval).",
      family: HOSTING,
      chargeType: "recurring",
      unitOfMeasure: "TB",
    },
    45,
    COST_RATIO.hosting,
  ),
  product(
    {
      sku: "HST-CLD-T1",
      name: "Cold Storage - HealthData Locker Tier 1",
      description: "Lowest-cost long-term retention for data requiring minimal to no access.",
      family: HOSTING,
      chargeType: "recurring",
      unitOfMeasure: "TB",
      minQuantity: 5,
      floorDiscountPercent: 25,
      attributes: { Excludes: "ADD-ROI and ADD-ARM" },
    },
    22,
    COST_RATIO.hosting,
  ),
  percentOf(
    {
      sku: "HST-DR",
      name: "Disaster Recovery Replica",
      description: "Geo-redundant replica of the hot archive in a secondary US region.",
      family: HOSTING,
      chargeType: "recurring",
      optionGroups: [picklist("Recovery region", ["US-East", "US-Central", "US-West"], true)],
      attributes: { Requires: "HST-HOT", "Recovery region": "Must differ from the hosting region" },
    },
    0.4,
    COST_RATIO.hosting,
    "monthly hot storage",
  ),
];

/* ------------------------------ price books ------------------------------- */

const BOOK_LIST = "Archive list";
const BOOK_RIVERBEND = "Riverbend Health System contract";
const BOOK_LAKESHORE = "Lakeshore consolidation program";
const BOOK_PRAIRIE = "Prairie View Community Health contract";
const BOOK_HARBORVIEW = "Harborview Children's contract";

/**
 * The list book, and one contract book per customer the workbook gives a rate.
 * A contract book holds only what was contracted: anything it does not name
 * prices off the catalogue. Windows are relative to the install so the sample
 * does not expire on a date.
 */
export const HEALTHCARE_PRICE_BOOKS: PriceBookInput[] = [
  {
    name: BOOK_LIST,
    description: "The workbook's list prices. Illustrative, as the workbook itself says.",
    currency: "USD",
    isDefault: true,
    active: true,
    validFrom: "",
    validTo: "",
    entries: HEALTHCARE_PRODUCTS.map(entry => ({ sku: entry.sku, unitPrice: entry.listPrice, active: true })),
  },
  {
    name: BOOK_RIVERBEND,
    description: "Contracted Hot Storage rate under a 3-year MSLA.",
    currency: "USD",
    isDefault: false,
    active: true,
    validFrom: addDays(todayIso(), -240),
    validTo: addDays(todayIso(), 855),
    entries: [{ sku: "HST-HOT", unitPrice: 240, active: true }],
  },
  {
    name: BOOK_LAKESHORE,
    description: "Multi-system consolidation program rate for standard extractions.",
    currency: "USD",
    isDefault: false,
    active: true,
    validFrom: addDays(todayIso(), -300),
    validTo: addDays(todayIso(), 365),
    entries: [{ sku: "SVC-EXT-STD", unitPrice: 19_500, active: true }],
  },
  {
    name: BOOK_PRAIRIE,
    description: "Contracted standard support rate: 16% of license rather than 18%.",
    currency: "USD",
    isDefault: false,
    active: true,
    validFrom: addDays(todayIso(), -120),
    validTo: addDays(todayIso(), 245),
    entries: [{ sku: "SUP-STD", unitPrice: 0.16, active: true }],
  },
  {
    name: BOOK_HARBORVIEW,
    description: "Premium support at 20% of license, and the pediatric migration rate, under the merger letter of intent.",
    currency: "USD",
    isDefault: false,
    active: true,
    validFrom: addDays(todayIso(), -60),
    validTo: addDays(todayIso(), 670),
    entries: [
      { sku: "SUP-PRM", unitPrice: 0.2, active: true },
      { sku: "SVC-MIG", unitPrice: 31_500, active: true },
    ],
  },
];

/* ----------------------------- pricing rules ------------------------------ */

const lineRule = (
  rule: Pick<PricingRuleInput, "name" | "description" | "condition" | "target" | "expression" | "priority" | "message"> &
    Partial<Pick<PricingRuleInput, "appliesToFamily" | "appliesToSku">>,
): PricingRuleInput => ({ scope: "line", appliesToFamily: "", appliesToSku: "", active: true, ...rule });

export const HEALTHCARE_PRICING_RULES: PricingRuleInput[] = [
  lineRule({
    name: "Hot Storage 11-50 TB rate",
    description: "The published tier. min() so a contracted rate below it survives.",
    appliesToSku: "HST-HOT",
    condition: "quantity >= 11 && quantity <= 50",
    target: "unitPrice",
    expression: "min(unitPrice, 275)",
    priority: 10,
    message: "11-50 TB rate",
  }),
  lineRule({
    name: "Hot Storage 51+ TB rate",
    description: "The published tier. min() so a contracted rate below it survives.",
    appliesToSku: "HST-HOT",
    condition: "quantity >= 51",
    target: "unitPrice",
    expression: "min(unitPrice, 225)",
    priority: 10,
    message: "51+ TB rate",
  }),
  lineRule({
    name: "Volume - Hot Storage 100+ TB",
    description: "Automatic, and stacks with the term discount.",
    appliesToSku: "HST-HOT",
    condition: "quantity >= 100",
    target: "discountPercent",
    expression: "max(discountPercent, 10)",
    priority: 20,
    message: "100+ TB volume",
  }),
  lineRule({
    name: "Volume - Cold Storage 250+ TB",
    description: "Automatic on Tier 1 cold storage.",
    appliesToSku: "HST-CLD-T1",
    condition: "quantity >= 250",
    target: "discountPercent",
    expression: "max(discountPercent, 15)",
    priority: 20,
    message: "250+ TB volume",
  }),
  lineRule({
    name: "Multi-System Extraction",
    description: "Five or more source systems, for technology consolidation programs.",
    appliesToSku: "SVC-EXT-STD",
    condition: "quantity >= 5",
    target: "discountPercent",
    expression: "max(discountPercent, 12)",
    priority: 20,
    message: "Multi-system extraction",
  }),
  lineRule({
    name: "Volume - Warm Storage 25+ TB",
    description: "Automatic on Locker Tier 3, for customers parking a whole retired system's images there.",
    appliesToSku: "HST-WRM",
    condition: "quantity >= 25",
    target: "discountPercent",
    expression: "max(discountPercent, 10)",
    priority: 20,
    message: "25+ TB warm storage volume",
  }),
  lineRule({
    name: "5-Year Hosting Commitment",
    description: "Runs last and adds rather than takes the larger, because the workbook marks it stackable.",
    appliesToFamily: HOSTING,
    condition: "termMonths >= 60",
    target: "discountPercent",
    expression: "discountPercent + 8",
    priority: 30,
    message: "5-year hosting commitment",
  }),
];

/* ----------------------------- approval rules ----------------------------- */

/**
 * The workbook's ladder. Its VP-then-CRO sequence is what levels already do:
 * a quote needs every level at or below the highest it triggers. Every rung
 * names the installer, so one person can walk it, as in the first sample.
 */
export const healthcareApprovalRules = (approverEmail: string): ApprovalRuleInput[] => [
  {
    name: "VP Discount",
    scope: "quote",
    metric: "discountPercent",
    comparator: ">",
    threshold: 5,
    condition: "",
    level: 1,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "Discounts past 5% need the VP of Sales.",
    active: true,
  },
  {
    name: "Executive Discount",
    scope: "quote",
    metric: "discountPercent",
    comparator: ">",
    threshold: 15,
    condition: "",
    level: 2,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "Discounts past 15% need the CRO as well.",
    active: true,
  },
  {
    name: "Below-Floor Rate",
    scope: "line",
    metric: "floorBreach",
    comparator: ">",
    threshold: 0,
    condition: "",
    level: 2,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "A line was priced past the ceiling its product allows, which needs the CRO.",
    active: true,
  },
  {
    name: "Term Beyond Five Years",
    scope: "quote",
    metric: "termMonths",
    comparator: ">",
    threshold: 60,
    condition: "",
    level: 1,
    approvers: [approverEmail],
    approvalsRequired: 1,
    rejectionsRequired: 1,
    message: "A commitment longer than the five-year hosting term needs Finance to sign off on the revenue schedule.",
    active: true,
  },
];

/* -------------------------------- accounts -------------------------------- */

type HealthcareAccount = AccountInput & { priceBookName?: string };

const address = (line1: string, city: string, state: string, postalCode: string) => ({
  line1,
  line2: "",
  city,
  state,
  postalCode,
  country: "United States",
});

function account(
  fields: Pick<AccountInput, "name" | "industry" | "website" | "status" | "tags" | "contacts" | "billingAddress" | "notes"> &
    Partial<Pick<AccountInput, "paymentTerms" | "paymentTermDays" | "creditLimit">> & { priceBookName?: string },
): HealthcareAccount {
  return {
    shippingAddress: fields.billingAddress,
    shippingSameAsBilling: true,
    currency: "USD",
    priceBookId: "",
    paymentTerms: "Net 30",
    paymentTermDays: 30,
    creditLimit: 0,
    defaultDiscountPercent: 0,
    // Nonprofit and public healthcare buyers: no tax on any of these quotes.
    taxExempt: true,
    taxPercent: 0,
    ...fields,
  };
}

export const HEALTHCARE_ACCOUNTS: HealthcareAccount[] = [
  account({
    name: "Riverbend Health System",
    industry: "Acute care hospital system",
    website: "https://riverbend-health.example.org",
    status: "customer",
    tags: ["acute", "ehr-sunset", "msla"],
    priceBookName: BOOK_RIVERBEND,
    creditLimit: 1_500_000,
    contacts: [
      { id: "con_riverbend_imani", name: "Imani Castellanos", title: "CIO", email: "imani.castellanos@riverbend-health.example.org", phone: "+1 555 010 4410", role: "commercial", primary: true },
      { id: "con_riverbend_tobias", name: "Tobias Nakamura", title: "Director, Revenue Integrity", email: "t.nakamura@riverbend-health.example.org", phone: "", role: "technical", primary: false },
      { id: "con_riverbend_ap", name: "Accounts Payable", title: "", email: "ap@riverbend-health.example.org", phone: "", role: "billing", primary: false },
    ],
    billingAddress: address("2400 Riverbend Parkway", "Springfield", "MO", "65801"),
    notes: "Fictional. Retiring TruBridge for a new EHR, with A/R to wind down afterwards. Holds a $15,000 account credit on the TruBridge license under an MSLA amendment.",
  }),
  account({
    name: "Lakeshore Regional Medical Center",
    industry: "Regional medical center",
    website: "https://lakeshore-regional.example.org",
    status: "customer",
    tags: ["acute", "consolidation", "multi-system"],
    priceBookName: BOOK_LAKESHORE,
    creditLimit: 2_500_000,
    contacts: [
      { id: "con_lakeshore_renee", name: "Renee Oyelaran", title: "VP, Applications", email: "renee.oyelaran@lakeshore-regional.example.org", phone: "+1 555 010 7732", role: "commercial", primary: true },
      { id: "con_lakeshore_marek", name: "Marek Lindqvist", title: "Chief Financial Officer", email: "m.lindqvist@lakeshore-regional.example.org", phone: "", role: "signatory", primary: false },
    ],
    billingAddress: address("100 Harbor Drive", "Traverse City", "MI", "49684"),
    notes: "Fictional. Five legacy systems inherited through two acquisitions, consolidating on one archive.",
  }),
  account({
    name: "Prairie View Community Health",
    industry: "Federally qualified health center",
    website: "https://prairieview-chc.example.org",
    status: "customer",
    tags: ["fqhc", "ambulatory"],
    priceBookName: BOOK_PRAIRIE,
    paymentTerms: "Net 45",
    paymentTermDays: 45,
    contacts: [
      { id: "con_prairie_lena", name: "Lena Whitehorse", title: "Practice Administrator", email: "l.whitehorse@prairieview-chc.example.org", phone: "+1 555 010 2286", role: "commercial", primary: true },
    ],
    billingAddress: address("815 Prairie Avenue", "Salina", "KS", "67401"),
    notes: "Fictional. An FQHC, so licenses take the 10% program discount. Replacing eClinicalWorks.",
  }),
  account({
    name: "Bluff County Memorial Hospital",
    industry: "Critical access hospital",
    website: "https://bluffcounty-memorial.example.org",
    status: "prospect",
    tags: ["cah", "rural"],
    contacts: [
      { id: "con_bluff_owen", name: "Owen Sandoval", title: "Administrator", email: "o.sandoval@bluffcounty-memorial.example.org", phone: "+1 555 010 9154", role: "commercial", primary: true },
    ],
    billingAddress: address("12 Hospital Road", "Decorah", "IA", "52101"),
    notes: "Fictional. A 25-bed critical access hospital, so licenses take the 10% rural program discount.",
  }),
  account({
    name: "Cedar Valley Health Plan",
    industry: "Managed care organization",
    website: "https://cedarvalleyplan.example.com",
    status: "prospect",
    tags: ["payer", "multi-state"],
    creditLimit: 750_000,
    contacts: [
      { id: "con_cedar_priya", name: "Priya Halloran", title: "Director, Delegation Oversight", email: "p.halloran@cedarvalleyplan.example.com", phone: "+1 555 010 6620", role: "commercial", primary: true },
    ],
    billingAddress: address("500 Cedar Plaza", "Cedar Rapids", "IA", "52401"),
    notes: "Fictional. Needs delegated-entity oversight across six states.",
  }),
  account({
    name: "Harborview Children's Hospital",
    industry: "Pediatric acute care hospital",
    website: "https://harborview-childrens.example.org",
    status: "customer",
    tags: ["acute", "pediatric", "post-merger", "epic"],
    priceBookName: BOOK_HARBORVIEW,
    paymentTerms: "Net 45",
    paymentTermDays: 45,
    creditLimit: 1_000_000,
    contacts: [
      { id: "con_harborview_amara", name: "Amara Delacroix-Finch", title: "VP, Clinical Informatics", email: "a.delacroix-finch@harborview-childrens.example.org", phone: "+1 555 010 3391", role: "commercial", primary: true },
      { id: "con_harborview_jun", name: "Jun-seo Albright", title: "HIM Director", email: "j.albright@harborview-childrens.example.org", phone: "", role: "technical", primary: false },
      { id: "con_harborview_ap", name: "Accounts Payable", title: "", email: "payables@harborview-childrens.example.org", phone: "", role: "billing", primary: false },
    ],
    billingAddress: address("1 Lighthouse Way", "Portland", "ME", "04101"),
    notes: "Fictional. Merged into a regional system on Epic; its own Epic instance retires. Pediatric records are kept until the patient turns 21, so retention is the 21-year option.",
  }),
  account({
    name: "Summit Ridge Orthopedic Partners",
    industry: "Orthopedic physician group and ASC",
    website: "https://summitridge-ortho.example.com",
    status: "customer",
    tags: ["ambulatory", "asc", "private-equity"],
    contacts: [
      { id: "con_summit_garrett", name: "Garrett Osei", title: "Chief Operating Officer", email: "g.osei@summitridge-ortho.example.com", phone: "+1 555 010 5807", role: "commercial", primary: true },
      { id: "con_summit_billing", name: "Billing Office", title: "", email: "billing@summitridge-ortho.example.com", phone: "", role: "billing", primary: false },
    ],
    billingAddress: address("7800 Summit Ridge Boulevard", "Boulder", "CO", "80301"),
    notes: "Fictional. A roll-up of three practices, two on athenahealth and one on Greenway, consolidating onto one PM system.",
  }),
];

/* --------------------------------- quotes --------------------------------- */

/** How far along its life a sample quote is left. */
export type SampleQuoteStage = "draft" | "in_review" | "approved" | "sent" | "accepted";

export type SampleQuoteLine = {
  sku: string;
  quantity: number;
  discountPercent: number;
  options: readonly string[];
  /** Answers a picklist cannot hold: the real bed count, the retirement date. */
  description?: string;
  /** Nests the line under the line for this SKU. */
  parentSku?: string;
  /** For a recurring line that runs shorter than the quote's own term. */
  termMonths?: number;
  /**
   * For a percent-of line: the SKUs whose list value `quantity` has to equal.
   * Nothing reads this but the test that holds the arithmetic to it.
   */
  basis?: readonly string[];
};

export type SampleQuote = {
  name: string;
  accountName: string;
  termMonths: number;
  /** A whole-quote discount, for the promotions a rule cannot see. */
  discountPercent?: number;
  notes: string;
  internalNotes: string;
  stage?: SampleQuoteStage;
  note?: string;
  /** The sample opportunity this quote is written for, by name. */
  opportunityName?: string;
  lines: readonly SampleQuoteLine[];
};

const RIVERBEND_LICENSES = ["ARC-TBR-CPSI", "ARC-TBR-CPSI-CLN", "ARC-TBR-CPSI-RCM", "ARC-TBR-CPSI-HRP", "ARC-TBR-CPSI-APGL"];
const LAKESHORE_LICENSES = [
  "ARC-MTX",
  "ARC-MTX-CLN",
  "ARC-MTX-RCM",
  "ARC-MTX-HRP",
  "ARC-LAW",
  "ARC-LAW-HRP",
  "ARC-LAW-APGL",
  "ARC-ECW",
  "ARC-ATH",
  "ARC-NXG",
];
const PRAIRIE_LICENSES = ["ARC-ECW", "ARC-ECW-EHR", "ARC-ECW-PM"];
const BLUFF_LICENSES = ["ARC-MTX", "ARC-MTX-CLN"];
const HARBORVIEW_LICENSES = ["ARC-EPC", "ARC-EPC-CLN", "ARC-EPC-RES"];
const HARBORVIEW_SERVICES = ["SVC-EXT-STD", "SVC-MIG", "SVC-DOC", "SVC-IMP"];
const SUMMIT_LICENSES = ["ARC-ATH", "ARC-GRW"];

const line = (
  sku: string,
  quantity: number,
  options: readonly string[] = [],
  rest: Omit<SampleQuoteLine, "sku" | "quantity" | "options" | "discountPercent"> & { discountPercent?: number } = {},
): SampleQuoteLine => ({ sku, quantity, options, discountPercent: 0, ...rest });

/* ------------------------------ opportunities ----------------------------- */

const OPP_RIVERBEND = "Riverbend - TruBridge sunset";
const OPP_LAKESHORE = "Lakeshore - Q4 2026 consolidation";
const OPP_PRAIRIE = "Prairie View - eClinicalWorks archive";
const OPP_PRAIRIE_WARM = "Prairie View - Warm storage expansion";
const OPP_BLUFF = "Bluff County - MEDITECH archive";
const OPP_CEDAR = "Cedar Valley - Managed care oversight";
const OPP_HARBORVIEW = "Harborview - Epic post-merger archive";
const OPP_SUMMIT = "Summit Ridge - Ambulatory archive consolidation";

export type SampleOpportunity = {
  name: string;
  accountName: string;
  stage: OpportunityStage;
  /** Omitted, the deal is worth what the quote written for it comes to. */
  amount?: number;
  /** Omitted, the stage's own probability. */
  probability?: number;
  /** Relative to the install: negative is a deal that closed (or should have) that many days ago. */
  closeInDays: number;
  source: LeadSource;
  /** Who the deal is with, by email. Omitted, the customer's primary contact. */
  contactEmail?: string;
  nextStep: string;
  lossReason?: string;
  notes: string;
};

/**
 * One deal behind every sample quote, and one with no quote at all, lost —
 * so the pipeline has a win rate to show rather than 100%.
 */
export const HEALTHCARE_OPPORTUNITIES: SampleOpportunity[] = [
  {
    name: OPP_RIVERBEND,
    accountName: "Riverbend Health System",
    stage: "closed_won",
    closeInDays: -30,
    source: "outbound",
    nextStep: "Kickoff with the extraction team.",
    notes: "Signed under the MSLA amendment, credit included.",
  },
  {
    name: OPP_LAKESHORE,
    accountName: "Lakeshore Regional Medical Center",
    stage: "negotiation",
    probability: 80,
    closeInDays: 40,
    source: "referral",
    contactEmail: "m.lindqvist@lakeshore-regional.example.org",
    nextStep: "CFO signature on the order form before the year-end promotion runs out.",
    notes: "Referred by Riverbend's CIO. Approved through the CRO.",
  },
  {
    name: OPP_PRAIRIE,
    accountName: "Prairie View Community Health",
    stage: "proposal",
    closeInDays: 30,
    source: "web",
    nextStep: "Grant officer to confirm the drawdown schedule.",
    notes: "HRSA capital grant; the money is there but has to be drawn by quarter.",
  },
  {
    name: OPP_PRAIRIE_WARM,
    accountName: "Prairie View Community Health",
    stage: "prospecting",
    closeInDays: 120,
    source: "outbound",
    nextStep: "Count the boxes: they think it is 30 TB once scanned.",
    notes: "Paper charts from the two clinics they took over last year.",
  },
  {
    name: OPP_BLUFF,
    accountName: "Bluff County Memorial Hospital",
    stage: "negotiation",
    probability: 60,
    closeInDays: 21,
    source: "partner",
    nextStep: "VP sign-off on the extra 8%, then send.",
    notes: "Came through the state rural hospital association. A competing bid is in.",
  },
  {
    name: OPP_CEDAR,
    accountName: "Cedar Valley Health Plan",
    stage: "qualification",
    closeInDays: 75,
    source: "event",
    nextStep: "Scoping call on the custom reports, and whether MI and OH are in.",
    notes: "Met at the AHIP conference.",
  },
  {
    name: "Cedar Valley - Provider directory archive",
    accountName: "Cedar Valley Health Plan",
    stage: "closed_lost",
    amount: 85_000,
    closeInDays: -55,
    source: "event",
    nextStep: "",
    lossReason: "Bundled into their claims vendor's renewal at no extra cost.",
    notes: "Lost on price to a bundle, not on product. Worth asking again at that renewal.",
  },
  {
    name: OPP_HARBORVIEW,
    accountName: "Harborview Children's Hospital",
    stage: "proposal",
    probability: 55,
    closeInDays: 50,
    source: "referral",
    nextStep: "Walk the HIM director through the 21-year retention plan.",
    notes: "The acquiring system's Epic team is driving the timeline; the instance goes read-only in the spring.",
  },
  {
    name: OPP_SUMMIT,
    accountName: "Summit Ridge Orthopedic Partners",
    stage: "closed_won",
    closeInDays: -12,
    source: "web",
    nextStep: "Extraction kickoff with both vendors.",
    notes: "Came in through the website after their PE sponsor mandated one PM system.",
  },
];

/* ---------------------------------- leads --------------------------------- */

export type SampleLead = {
  name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  source: LeadSource;
  status: "new" | "working" | "qualified" | "unqualified";
  estimatedAmount: number;
  notes: string;
  /**
   * Converted after it is created, onto this existing customer, opening this
   * deal — the way the *Convert* button does.
   */
  convert?: { accountName: string; opportunityName: string; stage: OpportunityStage; closeInDays: number };
};

export const HEALTHCARE_LEADS: SampleLead[] = [
  {
    name: "Dana Okafor",
    company: "Lakeshore Regional Medical Center",
    title: "Director, Health Information Management",
    email: "d.okafor@lakeshore-regional.example.org",
    phone: "+1 555 010 7790",
    website: "",
    industry: "Regional medical center",
    source: "event",
    status: "qualified",
    estimatedAmount: 28_800,
    notes: "Stopped by the booth at the state HIMA meeting: release-of-information requests against the archive once it is live.",
    convert: {
      accountName: "Lakeshore Regional Medical Center",
      opportunityName: "Lakeshore - Release of Information",
      stage: "qualification",
      closeInDays: 90,
    },
  },
  {
    name: "Marisol Achterberg",
    company: "St. Brendan's Rehabilitation Hospital",
    title: "CFO",
    email: "m.achterberg@stbrendans-rehab.example.org",
    phone: "+1 555 010 4127",
    website: "https://stbrendans-rehab.example.org",
    industry: "Post-acute rehabilitation",
    source: "event",
    status: "working",
    estimatedAmount: 95_000,
    notes: "Moving off MEDITECH Magic. Wants A/R wind down more than the clinical archive.",
  },
  {
    name: "Theo Varga",
    company: "Northern Plains Lab Services",
    title: "IT Manager",
    email: "theo.varga@northernplainslab.example.com",
    phone: "",
    website: "https://northernplainslab.example.com",
    industry: "Reference laboratory",
    source: "referral",
    status: "qualified",
    estimatedAmount: 40_000,
    notes: "Referred by Prairie View. LIS replacement next summer; results have to stay reachable for 10 years.",
  },
  {
    name: "Ruth Ellingboe",
    company: "Mesa Verde Behavioral Health",
    title: "Compliance Officer",
    email: "r.ellingboe@mesaverde-bh.example.org",
    phone: "",
    website: "",
    industry: "Behavioral health",
    source: "web",
    status: "new",
    estimatedAmount: 0,
    notes: "Downloaded the 42 CFR Part 2 retention guide.",
  },
  {
    name: "",
    company: "Tri-County Public Health Department",
    title: "",
    email: "",
    phone: "+1 555 010 0300",
    website: "https://tricounty-health.example.gov",
    industry: "Public health",
    source: "outbound",
    status: "new",
    estimatedAmount: 0,
    notes: "Immunization registry vendor is sunsetting its hosted product. Find out who owns it.",
  },
  {
    name: "Felix Brandvold",
    company: "Copperline Dental Group",
    title: "Office Manager",
    email: "felix@copperline-dental.example.com",
    phone: "",
    website: "",
    industry: "Dental practice",
    source: "advertising",
    status: "unqualified",
    estimatedAmount: 0,
    notes: "Four chairs and one system. Their PM vendor's export does what they need; pointed them at it.",
  },
];

/* ---------------------------------- quotes -------------------------------- */

export const HEALTHCARE_QUOTES: SampleQuote[] = [
  {
    name: "Riverbend - TruBridge sunset and A/R wind down",
    opportunityName: OPP_RIVERBEND,
    accountName: "Riverbend Health System",
    termMonths: 36,
    stage: "accepted",
    notes: "Includes the $15,000 account credit on the TruBridge license under the signed MSLA amendment. Hot Storage at the contracted rate.",
    internalNotes: "The credit needs VP of Sales sign-off under policy, but at 12% off one line the quote as a whole stays under the 5% rung. Get it in writing.",
    lines: [
      line("ARC-TBR-CPSI", 1, ["bed_301", "facility_type_acute_hospital", "retention_10_years", "source_hosting_on_premise"], {
        discountPercent: 12,
        description: "340 licensed beds. System retires at the end of next quarter.",
      }),
      line("ARC-TBR-CPSI-CLN", 1, ["bed_301"], { parentSku: "ARC-TBR-CPSI" }),
      line("ARC-TBR-CPSI-RCM", 1, ["bed_301"], { parentSku: "ARC-TBR-CPSI" }),
      line("ARC-TBR-CPSI-HRP", 125_000, [], { parentSku: "ARC-TBR-CPSI", basis: ["ARC-TBR-CPSI"] }),
      line("ARC-TBR-CPSI-APGL", 125_000, [], { parentSku: "ARC-TBR-CPSI", basis: ["ARC-TBR-CPSI"] }),
      line("SVC-EXT-STD", 1, ["extraction_method_database_direct"]),
      line("SVC-IMP", 271_250, [], { basis: RIVERBEND_LICENSES }),
      line("SVC-PM", 103_875, [], { basis: ["SVC-EXT-STD", "SVC-IMP"] }),
      line("SUP-STD", 271_250, [], { basis: RIVERBEND_LICENSES }),
      line("HST-HOT", 24, ["hosting_region_us_central"]),
      line("HST-DR", 5_760, ["recovery_region_us_east"], { basis: ["HST-HOT"] }),
      line("ADD-ROI", 1, ["roi_partner_verisma"]),
      line("ADD-ARM", 1, ["bed_301", "wind_down_duration_18_months"], {
        termMonths: 18,
        description: "$42M open A/R at retirement.",
      }),
    ],
  },
  {
    name: "Lakeshore - Q4 2026 Consolidation",
    opportunityName: OPP_LAKESHORE,
    accountName: "Lakeshore Regional Medical Center",
    termMonths: 60,
    // The workbook's year-end promotion keys off the opportunity name, which a
    // rule cannot read.
    discountPercent: 7,
    stage: "approved",
    notes: "Five source systems consolidated on one archive. Pricing assumes a 60-month hosting commitment.",
    internalNotes: "Year-end promotion applied by hand; it runs out at the end of December. The 40 TB estimate comes from their storage audit.",
    lines: [
      line("ARC-MTX", 1, ["bed_101", "meditech_platform_client_server", "facility_type_acute_hospital", "retention_25_years"], {
        description: "212 licensed beds.",
      }),
      line("ARC-MTX-CLN", 1, ["bed_101"], { parentSku: "ARC-MTX" }),
      line("ARC-MTX-RCM", 1, ["bed_101"], { parentSku: "ARC-MTX" }),
      line("ARC-MTX-HRP", 78_000, [], { parentSku: "ARC-MTX", basis: ["ARC-MTX"] }),
      line("ARC-LAW", 1, ["retention_10_years"]),
      line("ARC-LAW-HRP", 65_000, [], { parentSku: "ARC-LAW", basis: ["ARC-LAW"] }),
      line("ARC-LAW-APGL", 65_000, [], { parentSku: "ARC-LAW", basis: ["ARC-LAW"] }),
      line("ARC-ECW", 1, ["provider_51", "facility_type_physician_group"], { description: "86 rendering providers." }),
      line("ARC-ATH", 1, ["provider_11", "facility_type_physician_group"], { description: "31 rendering providers." }),
      line("ARC-NXG", 1, ["provider_11", "includes_dental_yes", "facility_type_physician_group"], { description: "19 rendering providers." }),
      line("SVC-EXT-STD", 5, ["extraction_method_vendor_api"]),
      line("SVC-IMP", 354_150, [], { basis: LAKESHORE_LICENSES }),
      line("SVC-PM", 203_745, [], { basis: ["SVC-EXT-STD", "SVC-IMP"] }),
      line("SUP-STD", 354_150, [], { basis: LAKESHORE_LICENSES }),
      line("HST-HOT", 40, ["hosting_region_us_east"]),
    ],
  },
  {
    name: "Prairie View - eClinicalWorks archive",
    opportunityName: OPP_PRAIRIE,
    accountName: "Prairie View Community Health",
    termMonths: 36,
    stage: "sent",
    notes: "FQHC program pricing on all licenses. Support at the contracted 16%.",
    internalNotes: "Grant funded, so the invoice timing matters to them more than the price.",
    lines: [
      line("ARC-ECW", 1, ["provider_11", "facility_type_fqhc", "retention_10_years", "source_hosting_vendor_hosted"], {
        discountPercent: 10,
        description: "28 rendering providers.",
      }),
      line("ARC-ECW-EHR", 1, ["provider_11"], { discountPercent: 10, parentSku: "ARC-ECW" }),
      line("ARC-ECW-PM", 1, ["provider_11"], { discountPercent: 10, parentSku: "ARC-ECW" }),
      line("SVC-EXT-STD", 1, ["extraction_method_vendor_api"]),
      line("SVC-IMP", 45_600, [], { basis: PRAIRIE_LICENSES }),
      line("SUP-STD", 45_600, [], { basis: PRAIRIE_LICENSES }),
      line("HST-WRM", 3),
    ],
  },
  {
    name: "Bluff County - MEDITECH archive",
    opportunityName: OPP_BLUFF,
    accountName: "Bluff County Memorial Hospital",
    termMonths: 36,
    discountPercent: 8,
    stage: "in_review",
    note: "“Bluff County - MEDITECH archive” is waiting on you: approve it and you will see the ladder work.",
    notes: "Rural/CAH program pricing on all licenses, plus an additional 8% on the whole quote.",
    internalNotes: "The 8% is what it took to get ahead of the competing bid, and it is what puts this in front of the VP.",
    lines: [
      line("ARC-MTX", 1, ["bed_1", "meditech_platform_magic", "facility_type_critical_access_hospital", "retention_10_years"], {
        discountPercent: 10,
        description: "25 licensed beds.",
      }),
      line("ARC-MTX-CLN", 1, ["bed_1"], { discountPercent: 10, parentSku: "ARC-MTX" }),
      line("SVC-EXT-STD", 1, ["extraction_method_report_based"]),
      line("SVC-IMP", 26_100, [], { basis: BLUFF_LICENSES }),
      line("SUP-STD", 26_100, [], { basis: BLUFF_LICENSES }),
      line("HST-HOT", 2, ["hosting_region_us_central"]),
    ],
  },
  {
    name: "Cedar Valley - Managed Care Oversight",
    opportunityName: OPP_CEDAR,
    accountName: "Cedar Valley Health Plan",
    termMonths: 36,
    stage: "draft",
    notes: "Oversight configured for six states, with a custom report package.",
    internalNotes: "Still scoping the reports; they may add two more states.",
    lines: [
      line("MCO-PLT", 6, [], { description: "IA, IL, MN, MO, NE and WI." }),
      line("SVC-CRB", 80),
    ],
  },
  {
    name: "Harborview - Epic post-merger archive",
    accountName: "Harborview Children's Hospital",
    opportunityName: OPP_HARBORVIEW,
    termMonths: 60,
    stage: "sent",
    notes: "Pediatric retention: records kept to the patient's 21st birthday. Premium support at the contracted 20%.",
    internalNotes: "Five-year hosting term so the 8% commitment discount lands. Anything longer needs Finance.",
    lines: [
      line("ARC-EPC", 1, ["bed_101", "epic_data_source_both", "facility_type_acute_hospital", "retention_21_years_minors", "source_hosting_on_premise"], {
        description: "188 licensed beds. Chronicles review booked with the SE.",
      }),
      line("ARC-EPC-CLN", 1, ["bed_101"], { parentSku: "ARC-EPC" }),
      line("ARC-EPC-RES", 1, ["bed_101"], { parentSku: "ARC-EPC" }),
      line("SVC-EXT-STD", 1, ["extraction_method_database_direct"]),
      line("SVC-MIG", 2, ["target_system_epic"], { description: "Problem lists and immunizations into the surviving Epic." }),
      line("SVC-DOC", 3, [], { description: "About 3 million pages of scanned consent forms." }),
      line("SVC-IMP", 177_840, [], { basis: HARBORVIEW_LICENSES }),
      line("SVC-PM", 152_352, [], { basis: HARBORVIEW_SERVICES }),
      line("SUP-PRM", 177_840, [], { basis: HARBORVIEW_LICENSES }),
      line("HST-HOT", 18, ["hosting_region_us_east"]),
      line("ADD-CTX", 1, [], { description: "Launch from the acquiring system's Epic." }),
      line("ADD-ROI", 1, ["roi_partner_mro"]),
    ],
  },
  {
    name: "Summit Ridge - athenahealth and Greenway archive",
    accountName: "Summit Ridge Orthopedic Partners",
    opportunityName: OPP_SUMMIT,
    termMonths: 36,
    stage: "accepted",
    notes: "Two source systems onto one archive. Imaging from the closed Lakewood site goes to cold storage.",
    internalNotes: "The 5% on athena matched what their sponsor's other portfolio company paid.",
    lines: [
      line("ARC-ATH", 1, ["provider_51", "facility_type_physician_group", "retention_10_years", "source_hosting_vendor_hosted"], {
        discountPercent: 5,
        description: "64 rendering providers across two practices.",
      }),
      line("ARC-GRW", 1, ["provider_11", "facility_type_asc", "retention_7_years", "source_hosting_on_premise"], {
        description: "22 rendering providers.",
      }),
      line("SVC-EXT-STD", 2, ["extraction_method_vendor_api"]),
      line("SVC-IMP", 76_000, [], { basis: SUMMIT_LICENSES }),
      line("SUP-STD", 76_000, [], { basis: SUMMIT_LICENSES }),
      line("HST-HOT", 6, ["hosting_region_us_west"]),
      line("HST-CLD-T2", 12, [], { description: "Decommissioned imaging from the Lakewood site." }),
    ],
  },
  {
    name: "Prairie View - Warm storage expansion",
    accountName: "Prairie View Community Health",
    opportunityName: OPP_PRAIRIE_WARM,
    termMonths: 36,
    stage: "draft",
    notes: "Scanned paper charts from the two acquired clinics, alongside the eClinicalWorks archive.",
    internalNotes: "30 TB is their guess. The volume discount starts at 25, so it holds even if they are a little high.",
    lines: [
      line("SVC-DOC", 2, [], { description: "Roughly 2 million pages, scanned by their own vendor." }),
      line("HST-WRM", 30),
    ],
  },
];

/* -------------------------------- invoices -------------------------------- */

/**
 * The receivables book: one raised from an accepted quote, the rest for work
 * billed before this archive was ever sold — assessments, hours, an old
 * support year — spread across the aging. Every customer here is tax exempt.
 */
export const HEALTHCARE_INVOICES: SampleInvoice[] = [
  {
    accountName: "Riverbend Health System",
    // Billed from the accepted quote, Net 30, issued 18 days ago: not yet due, a deposit in.
    quoteName: "Riverbend - TruBridge sunset and A/R wind down",
    issuedDaysAgo: 18,
    poNumber: "RHS-PO-40117",
    notes: "The whole contract value, per the MSLA amendment. The deposit was received at signature.",
    lines: [],
    paidFraction: 0.25,
    paidDaysAgo: 9,
  },
  {
    accountName: "Lakeshore Regional Medical Center",
    // Net 30, issued 75 days ago and settled: the pilot that earned the consolidation deal.
    issuedDaysAgo: 75,
    poNumber: "LRMC-22-0918",
    notes: "Archive readiness assessment and pilot extraction of the Lawson AP/GL history.",
    lines: [
      { sku: "SVC-EXT-CPX", description: "Pilot extraction - Lawson AP/GL", quantity: 60, unitPrice: 225, taxPercent: 0 },
      { sku: "SVC-CRB", description: "Reconciliation reports for the pilot", quantity: 16, unitPrice: 195, taxPercent: 0 },
    ],
    paidFraction: 1,
    paidDaysAgo: 41,
  },
  {
    accountName: "Prairie View Community Health",
    // Net 45, issued 70 days ago: 25 days late and untouched — waiting on the grant drawdown.
    issuedDaysAgo: 70,
    poNumber: "PVCH-GR-0412",
    notes: "Interim warm storage for the eClinicalWorks export while the archive is contracted.",
    lines: [
      { sku: "HST-WRM", description: "Warm Storage - Locker Tier 3, 3 TB x 6 months", quantity: 18, unitPrice: 110, taxPercent: 0 },
    ],
    paidFraction: 0,
    paidDaysAgo: 0,
  },
  {
    accountName: "Summit Ridge Orthopedic Partners",
    // Net 30, issued 130 days ago: deep in 90+, part credited and part paid.
    issuedDaysAgo: 130,
    poNumber: "",
    notes: "Custom report build for the PE sponsor's diligence, billed monthly in arrears.",
    lines: [
      { sku: "SVC-CRB", description: "Custom Report/View Build - diligence pack", quantity: 48, unitPrice: 195, taxPercent: 0 },
    ],
    credit: { fraction: 0.25, reason: "goodwill", note: "Twelve hours rebuilt after we read the wrong fee schedule.", daysAgo: 95 },
    paidFraction: 0.35,
    paidDaysAgo: 60,
  },
  {
    accountName: "Harborview Children's Hospital",
    // Net 45, issued 4 days ago: current.
    issuedDaysAgo: 4,
    poNumber: "HCH-7731",
    notes: "Epic Chronicles source review ahead of the archive proposal.",
    lines: [
      { sku: "SVC-EXT-CPX", description: "Chronicles source review and sizing", quantity: 40, unitPrice: 225, taxPercent: 0 },
    ],
    paidFraction: 0,
    paidDaysAgo: 0,
  },
];
