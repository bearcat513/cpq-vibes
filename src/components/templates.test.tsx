/**
 * The template designer, rendered.
 *
 * The block editor is a switch over a union: a block type added to the format
 * without an editor for it fails at the moment someone clicks "Image", which
 * is both the worst time to find out and a thing a type error will not catch.
 * So every block type is rendered here, and so is a template carrying the two
 * things branding added — a letterhead and a picture in the flow.
 *
 * Static markup only, which is enough: the preview is an iframe fed by an
 * effect, and what is being checked is that nothing throws on first paint.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PdfTemplateEditor } from "@/components/app/PdfTemplateEditor";
import { TemplatesView } from "@/components/app/TemplatesView";
import {
  BLOCK_TYPES,
  blankBlock,
  invoicePdfSource,
  quotePdfSource,
  starterPdfTemplate,
  type PdfTemplate,
} from "@/lib/pdfTemplate";
import { SAMPLE_TEMPLATES, specimenInvoice, specimenQuote } from "@/lib/samples";
import { readPdfTemplate } from "@/lib/validate";
import type { TemplateKind } from "@/lib/types";

const seller = { sellerName: "Sam Rep", sellerEmail: "sam@seller.example.com", locale: "en-GB" };

const source = (kind: TemplateKind = "quote") =>
  kind === "invoice"
    ? invoicePdfSource({ invoice: specimenInvoice(), ...seller })
    : quotePdfSource({ quote: specimenQuote(), ...seller });

const editor = (template: PdfTemplate, kind: TemplateKind = "quote") =>
  renderToStaticMarkup(<PdfTemplateEditor template={template} source={source(kind)} onChange={() => {}} />);

describe("the PDF template editor", () => {
  test("every block type has an editor that renders", () => {
    for (const entry of BLOCK_TYPES) {
      const markup = editor({ ...starterPdfTemplate(), blocks: [blankBlock(entry.type)] });
      expect(markup).toContain(entry.label);
    }
  });

  test("a branded template renders its letterhead controls and its picture", () => {
    const branded = SAMPLE_TEMPLATES.find(entry => entry.name === "Proposal — branded PDF")!;
    const parsed = readPdfTemplate(branded.body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const markup = editor(parsed.value);
    expect(markup).toContain("Letterhead");
    // The panel is collapsed until it is opened, so what the summary says is
    // the only thing that tells you this template has a logo at all.
    expect(markup).toContain("logo");
  });

  test("every shipped PDF example opens in the editor", () => {
    for (const example of SAMPLE_TEMPLATES.filter(entry => entry.format === "pdf")) {
      const parsed = readPdfTemplate(example.body, example.kind);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(editor(parsed.value, example.kind).length).toBeGreaterThan(0);
    }
  });

  test("a block added to an invoice template starts as an invoice's", () => {
    // The same editor, the other vocabulary: a fresh totals block on an
    // invoice reads down to the balance, and on a quote down to the price.
    // (The field *lists* are Radix select contents, which a static render
    // does not open — the closed lists are asserted in pdfTemplate.test.ts.)
    const totals = (kind: TemplateKind) =>
      editor({ ...starterPdfTemplate(kind), blocks: [blankBlock("totals", kind)] }, kind);

    expect(totals("invoice")).toContain("Balance due");
    expect(totals("invoice")).not.toContain("List price");

    expect(totals("quote")).toContain("List price");
    expect(totals("quote")).not.toContain("Balance due");
  });

  test("every block type has an editor for an invoice too", () => {
    for (const entry of BLOCK_TYPES) {
      const markup = editor({ ...starterPdfTemplate("invoice"), blocks: [blankBlock(entry.type, "invoice")] }, "invoice");
      expect(markup).toContain(entry.label);
    }
  });
});

describe("the templates screen", () => {
  const view = (templates: never[] = []) =>
    renderToStaticMarkup(
      <TemplatesView
        templates={templates}
        sellerName="Sam Rep"
        sellerEmail="sam@seller.example.com"
        locale="en-GB"
        myId="usr_1"
        onChanged={async () => {}}
        onShare={() => {}}
        onError={() => {}}
        confirmed={() => true}
      />,
    );

  test("offers the shipped examples to start from", () => {
    // They are the documentation for the format, so they have to be reachable
    // from the screen rather than only from the sample installer.
    expect(view()).toContain("Start from an example");
  });

  test("both kinds have a way in, and the list is one of them at a time", () => {
    const markup = view();
    expect(markup).toContain("Quotes");
    expect(markup).toContain("Invoices");
    // Nothing yet, and the empty state says which nothing.
    expect(markup).toContain("No quote templates");
  });
});
