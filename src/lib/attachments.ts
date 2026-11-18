/**
 * Files attached to a record — one `sys_attachment` collection for every kind
 * of record, rather than a file field on each.
 *
 * An attachment names what it belongs to with two columns: `target` (which
 * kind of record) and `recordId`. One collection means one upload route, one
 * download route, one panel in the UI, and one set of access rules to keep
 * honest, however many record types grow a paperclip.
 *
 * **You see an attachment if you can see the record it is on**, and the rules
 * in `docker/pb_migrations/1750000012_attachments.js` are written to say
 * exactly that. `approvals` is not a collection: an approval request lives
 * inside its quote and is re-minted whenever the quote is repriced, so an
 * approval attachment hangs off the *quote* (`recordId` is the quote's id).
 * What sets it apart from a quote attachment is who may add one — the people
 * asked to approve, who cannot otherwise write to the quote at all.
 *
 * Pure: the browser reads these limits to refuse a file before uploading it,
 * and the server reads the same ones to refuse it again.
 */

export const ATTACHMENT_TARGETS = ["accounts", "quotes", "invoices", "approvals"] as const;
export type AttachmentTarget = (typeof ATTACHMENT_TARGETS)[number];

export const isAttachmentTarget = (value: unknown): value is AttachmentTarget =>
  typeof value === "string" && (ATTACHMENT_TARGETS as readonly string[]).includes(value);

/** Which collection holds the record an attachment of this kind belongs to. */
export const TARGET_COLLECTION: Record<AttachmentTarget, string> = {
  accounts: "accounts",
  quotes: "quotes",
  invoices: "invoices",
  approvals: "quotes",
};

export const TARGET_NOUN: Record<AttachmentTarget, string> = {
  accounts: "customer",
  quotes: "quote",
  invoices: "invoice",
  approvals: "approval",
};

/** 25 MB — the file field's `maxSize` in the migration says the same. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Per record. The hook counts and refuses past it. */
export const MAX_ATTACHMENTS_PER_RECORD = 50;

export const MAX_ATTACHMENT_NAME = 200;
export const MAX_ATTACHMENT_NOTE = 500;

/**
 * Types a browser may show in place rather than save. Anything else — HTML,
 * SVG, scripts — is only ever handed out as a download, because a file served
 * inline from this origin runs with this origin's cookies.
 */
export const INLINE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

export type Attachment = {
  id: string;
  target: AttachmentTarget;
  recordId: string;
  /** The name it was uploaded with. */
  name: string;
  size: number;
  mimeType: string;
  note: string;
  ownerId: string;
  orgId: string;
  createdAt: string;
};

/** "1.4 MB". Binary units, labelled the way every file manager labels them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Why this file cannot be attached, as a sentence — or null when it can. */
export function attachmentProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `${file.name || "That file"} is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}; an attachment may be ${formatBytes(MAX_ATTACHMENT_BYTES)} at most.`;
  }
  if (file.name.length > MAX_ATTACHMENT_NAME) {
    return `A file name may be ${MAX_ATTACHMENT_NAME} characters at most.`;
  }
  return null;
}
