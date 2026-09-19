/// <reference path="../pb_data/types.d.ts" />

/**
 * A template says what it is for.
 *
 * Invoices can be rendered through a template the way quotes always could,
 * and the two are one collection rather than two. A template is a template:
 * the name, the format, the letterhead, the block language and the sharing
 * are identical, and duplicating all of that to change the meaning of
 * `{{…}}` would be five files of copy for one column.
 *
 * What is *not* shared is the token vocabulary — `{{quote.validUntil}}` means
 * nothing on an invoice — and this column is what tells the renderer and the
 * editor which one to use. See `TemplateKind` in src/lib/types.ts.
 *
 * Every template that exists today is a quote's, so the column is backfilled
 * rather than left empty: an empty `kind` would read as "quote" in the app
 * anyway, but a column that means something only by omission is one somebody
 * will eventually read the wrong way round.
 */
migrate(
  app => {
    const templates = app.findCollectionByNameOrId("proposal_templates");

    if (!templates.fields.getByName("kind")) {
      templates.fields.add(
        new Field({
          type: "text",
          name: "kind",
          required: false,
          max: 20,
        }),
      );
      app.save(templates);
    }

    /*
     * Done in SQL, like every other backfill here: a text column is free of
     * the JSON trap that caught 1750000004, but the reason to prefer one
     * statement over a loop of reads and saves is the same — it touches the
     * stored rows once, and it is a statement a test can run.
     *
     * Exported as a constant because src/server/migration.test.ts runs this
     * exact statement against a throwaway database.
     */
    const BACKFILL_KIND = "UPDATE proposal_templates SET kind = 'quote' WHERE kind IS NULL OR trim(kind) = ''";

    app.db().newQuery(BACKFILL_KIND).execute();
  },
  app => {
    // Down: the column goes, and with it every invoice template's reason for
    // existing — they read as quote templates, which is what they were before
    // this migration made the distinction expressible.
    const templates = app.findCollectionByNameOrId("proposal_templates");
    if (templates.fields.getByName("kind")) {
      templates.fields.removeByName("kind");
      app.save(templates);
    }
  },
);
