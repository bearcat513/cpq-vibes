/**
 * Attachments: files on a customer, a quote, an invoice or an approval, all
 * kept in the one `sys_attachment` collection. See src/lib/attachments.ts for
 * the model and docker/pb_migrations/1750000012_attachments.js for who may do
 * what — this module grants nothing. Every call carries the caller's own
 * credential, and PocketBase's rules decide.
 *
 * The file itself never leaves PocketBase except through `attachmentFile`,
 * which asks for a file token *as the caller* — so the view rule is checked
 * once for the record and again for the bytes — and serves the bytes as a
 * download unless the type is one a browser can safely show in place.
 */
import { ClientResponseError } from "pocketbase";
import {
  attachmentProblem,
  INLINE_TYPES,
  isAttachmentTarget,
  MAX_ATTACHMENT_NOTE,
  TARGET_COLLECTION,
  TARGET_NOUN,
  type Attachment,
  type AttachmentTarget,
} from "../lib/attachments";
import { ApiError } from "./http";
import { clientFor, credentialHeaders, isNotFound, POCKETBASE_URL, toApiError, toIso } from "./pocketbase";

const COLLECTION = "sys_attachment";

/** PocketBase ids, and the `inv_` ones the invoice hook mints. */
const RECORD_ID = /^[a-z0-9_]{1,40}$/;

type Row = Record<string, unknown>;

function toAttachment(row: Row): Attachment {
  return {
    id: String(row.id ?? ""),
    target: String(row.target ?? "") as AttachmentTarget,
    recordId: String(row.recordId ?? ""),
    name: String(row.name || row.file || ""),
    size: Number(row.size ?? 0),
    mimeType: String(row.mimeType ?? ""),
    note: String(row.note ?? ""),
    ownerId: String(row.owner ?? ""),
    orgId: String(row.org ?? ""),
    createdAt: toIso(row.created),
  };
}

export function readTarget(value: unknown): AttachmentTarget {
  if (!isAttachmentTarget(value)) {
    throw new ApiError('"target" must be one of accounts, quotes, invoices or approvals.');
  }
  return value;
}

export function readRecordId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!RECORD_ID.test(id)) throw new ApiError('"recordId" must be the id of the record the file is on.');
  return id;
}

/** Everything attached to one record that the caller may see, newest first. */
export async function listAttachments(token: string, target: AttachmentTarget, recordId: string): Promise<Attachment[]> {
  const client = clientFor(token);
  try {
    const rows = await client.collection(COLLECTION).getFullList({
      filter: client.filter("target = {:target} && recordId = {:recordId}", { target, recordId }),
      sort: "-created",
    });
    return (rows as unknown as Row[]).map(toAttachment);
  } catch (error) {
    throw toApiError(error, "Could not read the attachments");
  }
}

export type AttachmentUpload = { target: AttachmentTarget; recordId: string; file: File; note: string };

/** Reads a `multipart/form-data` upload: `target`, `recordId`, `file`, and an optional `note`. */
export async function readUpload(req: Request): Promise<AttachmentUpload> {
  if (!(req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    throw new ApiError("Send the file as multipart/form-data, with `target`, `recordId` and `file` fields.");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError("The upload could not be read as multipart/form-data.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError('"file" must be a file.');
  const problem = attachmentProblem(file);
  if (problem) throw new ApiError(problem, file.size > 0 ? 413 : 400);

  const note = String(form.get("note") ?? "").trim();
  if (note.length > MAX_ATTACHMENT_NOTE) throw new ApiError(`A note may be ${MAX_ATTACHMENT_NOTE} characters at most.`);

  return { target: readTarget(form.get("target")), recordId: readRecordId(form.get("recordId")), file, note };
}

export async function createAttachment(token: string, upload: AttachmentUpload): Promise<Attachment> {
  const client = clientFor(token);
  const noun = TARGET_NOUN[upload.target];

  // Reading it first turns "no such record" and "not yours to see" into the
  // same 404 every other route gives, rather than a rule failure.
  try {
    await client.collection(TARGET_COLLECTION[upload.target]).getOne(upload.recordId, { fields: "id" });
  } catch (error) {
    if (isNotFound(error) || (error instanceof ClientResponseError && error.status === 403)) {
      throw new ApiError(`${noun[0]!.toUpperCase()}${noun.slice(1)} not found.`, 404);
    }
    throw toApiError(error, "Could not attach the file");
  }

  const form = new FormData();
  form.set("target", upload.target);
  form.set("recordId", upload.recordId);
  form.set("name", upload.file.name);
  form.set("mimeType", (upload.file.type || "application/octet-stream").slice(0, 200));
  form.set("note", upload.note);
  form.set("file", upload.file, upload.file.name);

  try {
    return toAttachment((await client.collection(COLLECTION).create(form)) as unknown as Row);
  } catch (error) {
    // A failed create *rule* comes back as a bare 400 with no field named:
    // that is the role, or the record, refusing — not a malformed request.
    if (
      error instanceof ClientResponseError &&
      error.status === 400 &&
      Object.keys(error.response?.data ?? {}).length === 0 &&
      !/carries|attach a file/i.test(String(error.response?.message ?? ""))
    ) {
      throw new ApiError(`You cannot attach files to this ${noun}.`, 403);
    }
    throw toApiError(error, "Could not attach the file");
  }
}

export async function deleteAttachment(token: string, id: string): Promise<boolean> {
  try {
    await clientFor(token).collection(COLLECTION).delete(id);
    return true;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    // Not there, and there but not yours to remove, read alike from outside.
    if (status === 404 || status === 403 || status === 400) return false;
    throw toApiError(error, "Could not remove the attachment");
  }
}

/** A filename safe in a header, with the real one in `filename*` for every browser that reads it. */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The bytes of one attachment, fetched from PocketBase as the caller.
 *
 * `inline` is honoured only for a type in `INLINE_TYPES`; anything else is a
 * download whatever was asked, with `nosniff` and a sandbox so nothing a file
 * contains can run as this origin.
 */
export async function attachmentFile(token: string, id: string, inline: boolean): Promise<Response | null> {
  const client = clientFor(token);

  let row: Row;
  try {
    row = (await client.collection(COLLECTION).getOne(id)) as unknown as Row;
  } catch (error) {
    if (isNotFound(error) || (error instanceof ClientResponseError && error.status === 403)) return null;
    throw toApiError(error, "Could not read the attachment");
  }

  const stored = String(row.file ?? "");
  if (!stored) return null;

  // A file token is minted for whoever asks, and PocketBase checks the view
  // rule again when it is spent. With an API key the SDK's own call would
  // carry no credential, so this is a plain fetch with the right header.
  let fileToken: string;
  try {
    const response = await fetch(`${POCKETBASE_URL}/api/files/token`, {
      method: "POST",
      headers: credentialHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new ApiError("Could not authorize the download.", response.status === 401 ? 401 : 502);
    fileToken = String(((await response.json()) as { token?: string }).token ?? "");
  } catch (error) {
    throw toApiError(error, "Could not authorize the download");
  }

  const url = `${POCKETBASE_URL}/api/files/${COLLECTION}/${encodeURIComponent(id)}/${encodeURIComponent(stored)}?token=${encodeURIComponent(fileToken)}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw toApiError(error, "Could not fetch the file");
  }
  if (upstream.status === 404 || upstream.status === 403) return null;
  if (!upstream.ok || !upstream.body) throw new ApiError("Could not fetch the file.", 502);

  const attachment = toAttachment(row);
  const type = (attachment.mimeType || upstream.headers.get("content-type") || "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const showInPlace = inline && INLINE_TYPES.has(type);

  const headers = new Headers({
    "Content-Type": showInPlace ? type : "application/octet-stream",
    "Content-Disposition": disposition(showInPlace ? "inline" : "attachment", attachment.name || stored),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  // Chrome will not open its PDF viewer in a sandboxed document, and the
  // viewer is its own sandbox anyway; everything else gets one.
  if (!(showInPlace && type === "application/pdf")) {
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
  }
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);

  return new Response(upstream.body, { status: 200, headers });
}
