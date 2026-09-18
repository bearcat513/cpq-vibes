import { useRef, useState } from "react";
import { ImageIcon, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "./common";
import { decodeImage } from "@/lib/image";
import { describeSize, prepareImageFile } from "@/lib/imageFile";
import { cn } from "@/lib/utils";

type Props = {
  /** A `data:` URL, or "" for nothing chosen yet. */
  value: string;
  onChange: (source: string) => void;
  /** Shown under the control — what this particular picture is for. */
  hint?: string;
};

/**
 * Choosing the picture that brands a document.
 *
 * The conversion is the substance of this control, not the file input. What
 * anyone actually has to hand is an RGBA logo or a 4000-pixel export, and a
 * PDF takes neither; `prepareImageFile` flattens and re-encodes in the
 * browser, so the only thing this has to do is say what it did. The stored
 * value is a `data:` URL, which is also what `<img>` wants — the thumbnail is
 * the same bytes the PDF will carry, with nothing in between to disagree.
 */
export function ImagePicker({ value, onChange, hint }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);

  // The stored picture described back: the editor should say 320×96, 4 kB
  // rather than leave someone wondering what they just put in the document.
  const decoded = value ? decodeImage(value) : null;
  const summary =
    decoded?.ok === true
      ? `${decoded.image.width}×${decoded.image.height} · ${describeSize(decoded.image.byteLength)} · ${decoded.image.mediaType.replace("image/", "")}`
      : "";

  const accept = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const prepared = await prepareImageFile(file);
      if (!prepared.ok) {
        setError(prepared.error);
        return;
      }
      onChange(prepared.image.source);
      if (prepared.image.note) setNote(`Prepared for print: ${prepared.image.note}.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That image could not be read.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <div
        onDragOver={event => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => {
          event.preventDefault();
          setDragging(false);
          void accept(event.dataTransfer.files[0]);
        }}
        className={cn(
          "flex items-center gap-3 rounded-md border border-dashed p-3",
          dragging && "border-primary bg-accent",
        )}
      >
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded border bg-[repeating-conic-gradient(#f4f4f5_0_25%,transparent_0_50%)] bg-[length:12px_12px]">
          {busy ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : value ? (
            <img src={value} alt="" className="max-h-16 max-w-16 object-contain" />
          ) : (
            <ImageIcon className="size-4 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>
              <Upload /> {value ? "Replace" : "Choose an image"}
            </Button>
            {value && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onChange("");
                  setNote("");
                  setError("");
                }}
              >
                <Trash2 /> Remove
              </Button>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {summary || "PNG or JPEG. Drop one here, or choose a file."}
          </p>
        </div>

        <input
          ref={input}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={event => void accept(event.target.files?.[0])}
        />
      </div>

      <Notice kind="error" lines={error ? [error] : []} />
      <Notice kind="info" lines={note ? [note] : []} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
