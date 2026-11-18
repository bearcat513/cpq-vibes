import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Download, Eye, File, FileImage, FileText, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Section } from "./common";
import { useAccess } from "./access";
import { api } from "@/lib/api";
import {
  attachmentProblem,
  formatBytes,
  INLINE_TYPES,
  MAX_ATTACHMENT_BYTES,
  TARGET_NOUN,
  type Attachment,
  type AttachmentTarget,
} from "@/lib/attachments";

type Props = {
  target: AttachmentTarget;
  /** The record's id — for an approval, the quote's. */
  recordId: string;
  /**
   * Whether this person may add a file here. A hint only: the collection's
   * create rule decides, and a refused upload says so.
   */
  canUpload: boolean;
  title?: string;
  description?: string;
  /** Renders without its own Section, to sit inside another panel. */
  bare?: boolean;
  locale?: string;
  onError: (error: unknown) => void;
  confirmed: (message: string) => boolean;
};

/**
 * The files on one record, and the place to drop another — the same panel on
 * a customer, a quote, an invoice and a quote's approvals, because they are
 * all rows in the one `sys_attachment` collection.
 */
export function Attachments({
  target,
  recordId,
  canUpload,
  title = "Attachments",
  description,
  bare,
  locale,
  onError,
  confirmed,
}: Props) {
  const access = useAccess();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [removing, setRemoving] = useState("");
  const [dragging, setDragging] = useState(false);

  const load = useCallback(async () => {
    try {
      setFiles(await api.listAttachments(target, recordId));
    } catch (error) {
      setFiles([]);
      onError(error);
    }
  }, [target, recordId, onError]);

  useEffect(() => {
    setFiles(null);
    void load();
  }, [load]);

  const upload = async (picked: FileList | File[]) => {
    const list = [...picked];
    if (!list.length) return;

    const refused = list.map(attachmentProblem).filter((problem): problem is string => Boolean(problem));
    if (refused.length) onError(new Error(refused.join(" ")));
    const accepted = list.filter(file => !attachmentProblem(file));

    for (const file of accepted) {
      setUploading(current => [...current, file.name]);
      try {
        const stored = await api.uploadAttachment(target, recordId, file);
        setFiles(current => [stored, ...(current ?? [])]);
      } catch (error) {
        onError(error);
      } finally {
        setUploading(current => {
          const at = current.indexOf(file.name);
          return at === -1 ? current : [...current.slice(0, at), ...current.slice(at + 1)];
        });
      }
    }
  };

  const remove = async (attachment: Attachment) => {
    if (!confirmed(`Remove ${attachment.name}? The file is deleted, not just unlinked.`)) return;
    setRemoving(attachment.id);
    try {
      await api.deleteAttachment(attachment.id);
      setFiles(current => (current ?? []).filter(other => other.id !== attachment.id));
    } catch (error) {
      onError(error);
    } finally {
      setRemoving("");
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (canUpload) void upload(event.dataTransfer.files);
  };

  // An admin may remove any file in the organization; anyone, what they put there.
  const canRemove = (attachment: Attachment) =>
    attachment.ownerId === access.userId || (access.role === "admin" && attachment.orgId === access.orgId);

  const date = (iso: string) => {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime())
      ? ""
      : parsed.toLocaleDateString(locale || undefined, { day: "numeric", month: "short", year: "numeric" });
  };

  const body = (
    <div
      onDragOver={event => {
        if (!canUpload) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn("relative", dragging && "bg-primary/5 outline-2 -outline-offset-2 outline-primary outline-dashed")}
    >
      {files === null ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">Loading attachments…</p>
      ) : files.length === 0 && uploading.length === 0 ? (
        <p className="flex items-center gap-1.5 px-4 py-3 text-xs text-muted-foreground">
          <Paperclip className="size-3.5" />
          {canUpload
            ? `Nothing attached. Drop a file here, or choose one — up to ${formatBytes(MAX_ATTACHMENT_BYTES)}.`
            : `Nothing attached to this ${TARGET_NOUN[target]}.`}
        </p>
      ) : (
        <ul className="divide-y">
          {uploading.map((name, index) => (
            <li key={`up-${index}-${name}`} className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="text-xs">uploading…</span>
            </li>
          ))}
          {files.map(attachment => {
            const Icon = attachment.mimeType.startsWith("image/")
              ? FileImage
              : attachment.mimeType === "application/pdf" || attachment.mimeType.startsWith("text/")
                ? FileText
                : File;
            const viewable = INLINE_TYPES.has(attachment.mimeType);
            return (
              <li key={attachment.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <a
                    href={api.attachmentUrl(attachment.id)}
                    className="block truncate font-medium hover:underline"
                    title={`Download ${attachment.name}`}
                  >
                    {attachment.name}
                  </a>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatBytes(attachment.size)}
                    {attachment.createdAt && ` · ${date(attachment.createdAt)}`}
                    {attachment.ownerId === access.userId && " · you"}
                    {attachment.note && ` · ${attachment.note}`}
                  </span>
                </div>
                {viewable && (
                  <Button variant="ghost" size="icon-sm" asChild title="Open in a new tab">
                    <a href={api.attachmentUrl(attachment.id, true)} target="_blank" rel="noopener noreferrer">
                      <Eye />
                    </a>
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" asChild title="Download">
                  <a href={api.attachmentUrl(attachment.id)} aria-label={`Download ${attachment.name}`}>
                    <Download />
                  </a>
                </Button>
                {canRemove(attachment) && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void remove(attachment)}
                    disabled={removing === attachment.id}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    {removing === attachment.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Trash2 className="text-muted-foreground hover:text-destructive" />
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  const picker = canUpload && (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={event => {
          if (event.target.files) void upload(event.target.files);
          event.target.value = "";
        }}
      />
      <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={uploading.length > 0}>
        {uploading.length > 0 ? <Loader2 className="animate-spin" /> : <Upload />} Attach
      </Button>
    </>
  );

  if (bare) {
    return (
      <div className="border-t">
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Paperclip className="size-3.5" /> {title}
            {files && files.length > 0 && <span className="tabular-nums">({files.length})</span>}
          </p>
          {picker}
        </div>
        {body}
      </div>
    );
  }

  return (
    <Section
      title={files && files.length > 0 ? `${title} (${files.length})` : title}
      description={description}
      actions={picker}
    >
      {body}
    </Section>
  );
}
