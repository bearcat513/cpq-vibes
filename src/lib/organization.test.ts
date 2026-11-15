import { describe, expect, test } from "bun:test";
import { can, canEditQuote, normalizeOrgSettings, PERMISSIONS, ROLES } from "./organization";
import { addDaysTo, isTimeZone, setTimeZoneProvider, today, todayIn } from "./clock";
import { effectiveStatus, withLifecycle } from "./quoteLifecycle";

describe("what each role may do", () => {
  test("an admin may do everything", () => {
    for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(can("admin", permission)).toBe(true);
    }
  });

  test("a viewer may do nothing", () => {
    for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(can("viewer", permission)).toBe(false);
    }
  });

  test("no role — no organization — is a viewer with less", () => {
    expect(can("", "accounts.write")).toBe(false);
    expect(can(undefined, "quotes.create")).toBe(false);
  });

  test("sales writes customers and quotes; finance writes customers and invoices", () => {
    expect(can("sales", "quotes.create")).toBe(true);
    expect(can("sales", "invoices.write")).toBe(false);
    expect(can("finance", "invoices.write")).toBe(true);
    expect(can("finance", "quotes.create")).toBe(false);
    expect(can("finance", "accounts.write")).toBe(true);
    expect(can("finance", "accounts.delete")).toBe(false);
  });

  test("every permission names only real roles", () => {
    for (const roles of Object.values(PERMISSIONS)) {
      for (const role of roles) expect(ROLES).toContain(role);
    }
  });
});

describe("who may edit a quote", () => {
  const me = { id: "u1", orgId: "org_a" };

  test("an admin, any quote in the organization", () => {
    expect(canEditQuote("admin", { ownerId: "u2", orgId: "org_a" }, me)).toBe(true);
  });

  test("a sales member, only their own", () => {
    expect(canEditQuote("sales", { ownerId: "u1", orgId: "org_a" }, me)).toBe(true);
    expect(canEditQuote("sales", { ownerId: "u2", orgId: "org_a" }, me)).toBe(false);
  });

  test("nobody, a quote from another organization — even one they own", () => {
    expect(canEditQuote("admin", { ownerId: "u1", orgId: "org_b" }, me)).toBe(false);
  });
});

describe("organization settings", () => {
  test("anything stored is read back with every key, and a bad zone is dropped", () => {
    expect(normalizeOrgSettings(null)).toEqual({ timeZone: "" });
    expect(normalizeOrgSettings({ timeZone: " Europe/London " }, isTimeZone)).toEqual({ timeZone: "Europe/London" });
    expect(normalizeOrgSettings({ timeZone: "Mars/Olympus" }, isTimeZone)).toEqual({ timeZone: "" });
  });
});

describe("today, in a time zone", () => {
  // 23:30 UTC on the 31st: already the 1st in Sydney, still the 31st in New York.
  const lateEvening = new Date("2026-12-31T23:30:00Z");

  test("is the date in that zone, not in UTC", () => {
    expect(todayIn("UTC", lateEvening)).toBe("2026-12-31");
    expect(todayIn("Australia/Sydney", lateEvening)).toBe("2027-01-01");
    expect(todayIn("America/New_York", lateEvening)).toBe("2026-12-31");
  });

  test("an unknown or empty zone is UTC", () => {
    expect(todayIn("", lateEvening)).toBe("2026-12-31");
    expect(todayIn("Mars/Olympus", lateEvening)).toBe("2026-12-31");
  });

  test("today() asks the provider", () => {
    setTimeZoneProvider(() => "Australia/Sydney");
    try {
      expect(today(lateEvening)).toBe("2027-01-01");
    } finally {
      setTimeZoneProvider(() => undefined);
    }
    expect(today(lateEvening)).toBe("2026-12-31");
  });

  test("adding days is calendar arithmetic, across a month end", () => {
    expect(addDaysTo("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysTo("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("a quote's effective status", () => {
  const sent = { status: "sent" as const, validUntil: "2026-06-30", supersededById: null };

  test("a sent quote past its date is expired; on the day it is not", () => {
    expect(effectiveStatus(sent, "2026-06-30")).toBe("sent");
    expect(effectiveStatus(sent, "2026-07-01")).toBe("expired");
  });

  test("superseded wins over expired, and never over accepted", () => {
    expect(effectiveStatus({ ...sent, supersededById: "q2" }, "2026-07-01")).toBe("superseded");
    expect(effectiveStatus({ status: "accepted", validUntil: "", supersededById: "q2" }, "2026-07-01")).toBe("accepted");
  });

  test("the stored status is untouched when nothing applies", () => {
    const draft = { status: "draft" as const, validUntil: "", supersededById: null };
    expect(withLifecycle(draft, "2026-07-01")).toBe(draft);
  });
});
