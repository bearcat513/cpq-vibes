/// <reference path="../pb_data/types.d.ts" />

/**
 * A proposal template can carry its own pictures.
 *
 * Branding a document means a logo on it, and a template's logo lives *in* the
 * template — a base64 `data:` URL inside the PDF body's JSON, beside the
 * blocks that use it. That is deliberate: a template is one record that gets
 * exported, shared with a colleague and imported somewhere else, and a
 * reference to a file kept anywhere but the record itself would break on the
 * first of those journeys.
 *
 * The cost is size. A letterhead is a few hundred kilobytes of base64, which
 * is an order of magnitude past what prose ever needs, so `body` is widened
 * to match `MAX_PDF_TEMPLATE_BODY_LENGTH` in src/lib/proposal.ts. The app
 * rejects an oversized body first, with a sentence; this is the backstop.
 *
 * Nothing is rewritten — every existing template is already valid at the new
 * width — so the down migration is only safe while no template has grown past
 * the old limit, and it says so rather than truncating someone's letterhead.
 */
migrate(
  app => {
    const templates = app.findCollectionByNameOrId("proposal_templates");
    const body = templates.fields.getByName("body");
    if (body) {
      body.max = 3000000;
      app.save(templates);
    }
  },
  app => {
    const templates = app.findCollectionByNameOrId("proposal_templates");

    // A body past the old limit would fail validation on its next save with an
    // error about a field nobody edited. Better to refuse the rollback and say
    // how many templates are in the way.
    let oversized = 0;
    for (const record of app.findAllRecords("proposal_templates")) {
      if (String(record.get("body") || "").length > 200000) oversized++;
    }

    if (oversized) {
      throw new Error(
        "Cannot narrow proposal_templates.body: " +
          oversized +
          " template(s) are longer than 200,000 characters. Remove their images first.",
      );
    }

    const body = templates.fields.getByName("body");
    if (body) {
      body.max = 200000;
      app.save(templates);
    }
  },
);
