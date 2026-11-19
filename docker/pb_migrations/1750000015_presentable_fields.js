/// <reference path="../pb_data/types.d.ts" />

/**
 * Which field stands for a record when another record points at it.
 *
 * `presentable` is display only: the dashboard shows these fields in a
 * relation's cell and picker instead of the bare id. It changes nothing in
 * the API or in any rule.
 *
 * - `sys_physical_location.name` — an account's billing and shipping
 *   relations read as the address on one line.
 * - `contacts.name` — a contact, wherever one is related.
 * - `accounts.name` — a contact's `account` relation reads as the customer.
 */
const PRESENTABLE = [
  ["sys_physical_location", "name"],
  ["contacts", "name"],
  ["accounts", "name"],
];

const mark = (app, value) => {
  for (const [collectionName, fieldName] of PRESENTABLE) {
    const collection = app.findCollectionByNameOrId(collectionName);
    const field = collection.fields.getByName(fieldName);
    if (!field) throw new Error(`${collectionName}.${fieldName} does not exist`);
    field.presentable = value;
    app.save(collection);
  }
};

migrate(
  app => mark(app, true),
  app => mark(app, false),
);
