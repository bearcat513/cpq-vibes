/**
 * `GET /api/table/:collection` — one page of any collection, filtered and
 * sorted by PocketBase itself, as the caller.
 *
 * This grants nothing. The request goes out on the caller's own credential,
 * so the collection's list rule decides which rows come back exactly as it
 * does for every other route — a viewer sees what a viewer may, a key sees
 * what its owner may, and `counters` (no user rules at all) is a 403 for
 * everyone. Hidden fields (an API key's hash) never leave PocketBase.
 *
 * The rows are the stored records, not the domain objects the rest of the API
 * hands out: no derived quote status, no invoice balance. It is a view of the
 * database, and says so on the page.
 */
import { ClientResponseError } from "pocketbase";
import {
  inferFields,
  isCollectionName,
  MAX_TABLE_PAGE_SIZE,
  stripMeta,
  type TablePage,
  type TableRecord,
} from "../lib/dataTable";
import { MAX_FILTER_LENGTH } from "../lib/filterQuery";
import { ApiError } from "./http";
import { clientFor, toApiError } from "./pocketbase";

export type TableRequest = { filter: string; sort: string; page: number; perPage: number };

export function readTableRequest(raw: { filter: string | null; sort: string; page: number; perPage: number }): TableRequest {
  const filter = (raw.filter ?? "").trim();
  if (filter.length > MAX_FILTER_LENGTH) {
    throw new ApiError(`The filter may be at most ${MAX_FILTER_LENGTH.toLocaleString()} characters.`);
  }
  if (raw.page < 1) throw new ApiError(`"page" starts at 1 (got ${raw.page}).`);
  if (raw.perPage < 1 || raw.perPage > MAX_TABLE_PAGE_SIZE) {
    throw new ApiError(`"perPage" must be between 1 and ${MAX_TABLE_PAGE_SIZE} (got ${raw.perPage}).`);
  }
  return { filter, sort: raw.sort, page: raw.page, perPage: raw.perPage };
}

/** PocketBase's answers, in sentences about this collection. */
function explain(error: unknown, collection: string, request: TableRequest): ApiError {
  if (error instanceof ClientResponseError) {
    if (error.status === 404) return new ApiError(`There is no collection called "${collection}".`, 404);
    if (error.status === 403) {
      return new ApiError(`You may not list "${collection}" — its rules do not let your account read it.`, 403);
    }
    if (error.status === 400) {
      const what = request.filter && request.sort ? "filter or sort" : request.filter ? "filter" : "sort";
      return new ApiError(
        `PocketBase refused the ${what}: check the field names and the syntax. (${error.response?.message || error.message})`,
        400,
      );
    }
  }
  return toApiError(error, `Could not list "${collection}"`);
}

export async function listTable(token: string, collection: string, request: TableRequest): Promise<TablePage> {
  if (!isCollectionName(collection)) throw new ApiError(`"${collection}" is not a collection name.`);

  const records = clientFor(token).collection(collection);
  let list;
  try {
    list = await records.getList<TableRecord>(request.page, request.perPage, {
      ...(request.filter ? { filter: request.filter } : {}),
      ...(request.sort ? { sort: request.sort } : {}),
    });
  } catch (error) {
    throw explain(error, collection, request);
  }

  let sample = list.items;
  // A filter that matches nothing still deserves columns to adjust it with:
  // read one unfiltered row for its shape. Its own failure is not this request's.
  if (sample.length === 0 && request.filter) {
    sample = await records
      .getList<TableRecord>(1, 1)
      .then(probe => probe.items)
      .catch(() => []);
  }

  return {
    collection,
    filter: request.filter,
    sort: request.sort,
    page: list.page,
    perPage: list.perPage,
    totalItems: list.totalItems,
    totalPages: list.totalPages,
    items: list.items.map(stripMeta),
    fields: inferFields(sample),
  };
}
