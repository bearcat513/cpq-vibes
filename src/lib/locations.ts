import type { Address } from "./types";

/**
 * A physical location — a `sys_physical_location` record — and the one-line
 * name it is known by.
 *
 * An account's billing and shipping addresses are relations to these (see
 * docker/pb_migrations/1750000014_account_normalize.js). The name is derived,
 * never typed: pb_hooks/rules/locations.js sets it on every save with the
 * same rule as `locationName` here, and the migration's SQL builds it the
 * same way for the rows it moves.
 */

/** The parts of an address, in the order they are written on an envelope. */
export const ADDRESS_PARTS = ["line1", "line2", "city", "state", "postalCode", "country"] as const satisfies readonly (keyof Address)[];

/** Every non-blank part, in order, joined with ", ". */
export const locationName = (address: Address): string =>
  ADDRESS_PARTS.map(part => address[part].trim())
    .filter(Boolean)
    .join(", ");

/** Nothing written in any part — which is no location at all, rather than an empty one. */
export const isBlankAddress = (address: Address): boolean => ADDRESS_PARTS.every(part => !address[part].trim());
