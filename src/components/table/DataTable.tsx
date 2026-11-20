import { useMemo, useState } from "react";
import {
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type PaginationState,
  type SortingState,
  type Updater,
  type ColumnVisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns3, Loader2, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { TABLE_PAGE_SIZES, type FieldInfo, type TableRecord } from "@/lib/dataTable";
import { cn } from "@/lib/utils";
import { nativeSelect } from "./QueryBuilder";

/**
 * One page of records, drawn by TanStack Table.
 *
 * PocketBase owns sorting and paging — a sort over the loaded page alone would
 * be a lie about the collection — so both run in manual mode: the table only
 * holds the state, the page puts it in the request, and the rows arrive
 * already in order. Visibility is the one thing done here.
 *
 * Features and the empty fallback live at module scope: v9 rebuilds its
 * models whenever either changes identity.
 *
 * On `lg` and up it is a grid in a window: it fills whatever height its
 * parent gives it, scrolls inside itself in both directions, and keeps the
 * heading row and the pager in view. Below that it is an ordinary block the
 * page scrolls past.
 */

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, columnVisibilityFeature });

type Props = {
  fields: FieldInfo[];
  rows: TableRecord[];
  totalItems: number;
  sorting: SortingState;
  onSortingChange: (updater: Updater<SortingState>) => void;
  pagination: PaginationState;
  onPaginationChange: (updater: Updater<PaginationState>) => void;
  loading: boolean;
  /** Opens a record. Rows are buttons when this is given. */
  onOpenRow?: (row: TableRecord) => void;
  /** The open record's id, drawn as selected. */
  selectedId?: string;
};

/** Numbers right-aligned in tabular figures, like every list in the app. */
const isNumeric = (field: FieldInfo) => field.type === "number";

/**
 * The first column (the id) stays in view while the rest scroll sideways, the
 * way a spreadsheet freezes its first column. Opaque, or the cells scrolling
 * under it would show through.
 */
const FROZEN = "lg:sticky lg:left-0 lg:z-[1] lg:bg-card lg:shadow-[1px_0_0_var(--border)]";

export function DataTable({
  fields,
  rows,
  totalItems,
  sorting,
  onSortingChange,
  pagination,
  onPaginationChange,
  loading,
  onOpenRow,
  selectedId,
}: Props) {
  // JSON fields are the whole domain object, and wide — off until asked for.
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const hiddenByDefault = useMemo(
    () => Object.fromEntries(fields.filter(field => field.type === "json").map(field => [field.name, false])),
    [fields],
  );
  const visibility = useMemo(() => ({ ...hiddenByDefault, ...columnVisibility }), [hiddenByDefault, columnVisibility]);

  const columns = useMemo<ColumnDef<typeof features, TableRecord>[]>(
    () =>
      fields.map(field => ({
        id: field.name,
        accessorFn: (row: TableRecord) => row[field.name],
        header: field.name,
        cell: info => <CellValue value={info.getValue()} type={field.type} />,
        // A JSON field is the whole nested object; ordering by it means nothing.
        enableSorting: field.type !== "json",
      })),
    [fields],
  );

  const table = useTable({
    features,
    columns,
    data: rows,
    state: { sorting, pagination, columnVisibility: visibility },
    onSortingChange,
    onPaginationChange,
    onColumnVisibilityChange: updater =>
      setColumnVisibility(typeof updater === "function" ? updater(visibility) : updater),
    manualSorting: true,
    manualPagination: true,
    rowCount: totalItems,
    enableMultiSort: true,
    autoResetPageIndex: false,
  });

  const fieldOf = (id: string) => fields.find(field => field.name === id);
  const pageCount = Math.max(1, table.getPageCount());
  const first = totalItems === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const last = Math.min(totalItems, (pagination.pageIndex + 1) * pagination.pageSize);

  return (
    <div className="panel flex flex-col overflow-hidden rounded-md border shadow-[0_1px_2px_var(--cast)] lg:min-h-0 lg:flex-1">
      <div className="seam flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <p className="text-xs text-muted-foreground tabular-nums">
          {totalItems === 0 ? "No rows" : `${first.toLocaleString()}–${last.toLocaleString()} of ${totalItems.toLocaleString()}`}
        </p>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Loading" />}
        <p className="hidden text-[11px] text-muted-foreground/80 md:block">
          Click a heading to sort; shift-click to add a second.{onOpenRow ? " Click a row to open it." : ""}
        </p>
        <ColumnPicker
          columns={table.getAllLeafColumns().map(column => ({
            id: column.id,
            visible: column.getIsVisible(),
            toggle: () => column.toggleVisibility(),
          }))}
          className="ml-auto"
        />
      </div>

      <div className={cn("flex min-h-0 flex-1 flex-col transition-opacity", loading && "opacity-60")}>
        <Table containerClassName="lg:min-h-0 lg:flex-1 lg:overflow-auto">
          <Thead className="lg:sticky lg:top-0 lg:z-10 lg:bg-card lg:shadow-[0_1px_0_var(--border)]">
            {table.getHeaderGroups().map(group => (
              <Tr key={group.id} className="hover:bg-transparent">
                {group.headers.map((header, index) => {
                  const field = fieldOf(header.column.id);
                  const sorted = header.column.getIsSorted();
                  const sortable = header.column.getCanSort();
                  const Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
                  return (
                    <Th
                      key={header.id}
                      numeric={field ? isNumeric(field) : false}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn("whitespace-nowrap py-1.5", index === 0 && FROZEN)}
                    >
                      {header.isPlaceholder ? null : sortable ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "inline-flex items-center gap-1 uppercase hover:text-foreground",
                            sorted && "text-foreground",
                          )}
                        >
                          <table.FlexRender header={header} />
                          <Icon className={cn("size-3", !sorted && "opacity-40")} />
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </Th>
                  );
                })}
              </Tr>
            ))}
          </Thead>
          <Tbody>
            {table.getRowModel().rows.length === 0 ? (
              <Tr className="hover:bg-transparent">
                <Td colSpan={Math.max(1, table.getVisibleLeafColumns().length)} className="py-10 text-center text-sm text-muted-foreground">
                  {loading ? "Loading…" : "Nothing matches this filter."}
                </Td>
              </Tr>
            ) : (
              table.getRowModel().rows.map(row => {
                const id = String(row.original.id ?? row.id);
                const open = onOpenRow && typeof row.original.id === "string" ? () => onOpenRow(row.original) : undefined;
                return (
                <Tr
                  key={id}
                  data-state={selectedId === id ? "selected" : undefined}
                  tabIndex={open ? 0 : undefined}
                  aria-label={open ? `Open ${id}` : undefined}
                  onClick={open}
                  onKeyDown={
                    open
                      ? event => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            open();
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    "group/row",
                    open && "cursor-pointer focus-visible:bg-accent/60 focus-visible:outline-none",
                    selectedId === id && "bg-accent/70",
                  )}
                >
                  {row.getVisibleCells().map((cell, index) => {
                    const field = fieldOf(cell.column.id);
                    return (
                      <Td
                        key={cell.id}
                        numeric={field ? isNumeric(field) : false}
                        // One line a row, like a desktop grid; the whole value is in the cell's tooltip.
                        className={cn(
                          "max-w-80 py-1.5 text-xs whitespace-nowrap",
                          index === 0 && FROZEN,
                          // The frozen cell is opaque, so it repeats the row's hover and selection itself.
                          index === 0 && "lg:group-hover/row:bg-[color-mix(in_oklch,var(--muted)_40%,var(--card))]",
                          index === 0 && selectedId === id && "lg:bg-[color-mix(in_oklch,var(--accent)_70%,var(--card))]",
                        )}
                      >
                        <table.FlexRender cell={cell} />
                      </Td>
                    );
                  })}
                </Tr>
                );
              })
            )}
          </Tbody>
        </Table>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          Rows
          <select
            value={pagination.pageSize}
            onChange={event => table.setPageSize(Number(event.target.value))}
            className={nativeSelect}
          >
            {TABLE_PAGE_SIZES.map(size => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto tabular-nums">
          Page {(pagination.pageIndex + 1).toLocaleString()} of {pageCount.toLocaleString()}
        </span>
        <div className="flex gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => table.firstPage()} disabled={!table.getCanPreviousPage()} aria-label="First page">
            <ChevronsLeft />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
            <ChevronRight />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => table.lastPage()} disabled={!table.getCanNextPage()} aria-label="Last page">
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Which columns show. A `<details>` rather than a menu: it needs no portal and closes itself. */
function ColumnPicker({
  columns,
  className,
}: {
  columns: { id: string; visible: boolean; toggle: () => void }[];
  className?: string;
}) {
  const shown = columns.filter(column => column.visible).length;
  return (
    <details className={cn("relative", className)}>
      <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2 text-xs hover:bg-accent [&::-webkit-details-marker]:hidden">
        <Columns3 className="size-3.5" />
        Columns
        <span className="text-muted-foreground tabular-nums">
          {shown}/{columns.length}
        </span>
      </summary>
      <div className="panel absolute right-0 z-30 mt-1 max-h-80 w-56 overflow-y-auto rounded-md border p-1 shadow-lg">
        {columns.map(column => (
          <label
            key={column.id}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-accent"
          >
            <input type="checkbox" checked={column.visible} onChange={column.toggle} className="accent-[var(--primary)]" />
            {column.id}
          </label>
        ))}
      </div>
    </details>
  );
}

/** PocketBase's `2026-01-31 12:00:00.000Z`, in the reader's own clock. */
function formatDate(text: string) {
  const parsed = new Date(text.replace(" ", "T"));
  return Number.isNaN(parsed.getTime())
    ? text
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CellValue({ value, type }: { value: unknown; type: FieldInfo["type"] }) {
  if (value === null || value === undefined || value === "") {
    return <Minus className="size-3 text-muted-foreground/50" aria-label="empty" />;
  }
  if (typeof value === "boolean") {
    return value ? <Check className="size-3.5 text-signal" aria-label="true" /> : <span className="text-muted-foreground">false</span>;
  }
  if (typeof value === "number") return <span className="tabular-nums">{value.toLocaleString()}</span>;
  if (type === "date" && typeof value === "string") {
    return (
      <span className="whitespace-nowrap" title={value}>
        {formatDate(value)}
      </span>
    );
  }
  if (Array.isArray(value) && value.every(entry => typeof entry === "string")) {
    if (value.length === 0) return <Minus className="size-3 text-muted-foreground/50" aria-label="empty" />;
    return (
      <span className="flex gap-1">
        {value.map((entry, index) => (
          <span key={index} className="rounded-sm border bg-muted/50 px-1 font-mono text-[11px]">
            {entry}
          </span>
        ))}
      </span>
    );
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return (
      <code className="block truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(value, null, 2)}>
        {text}
      </code>
    );
  }
  const text = String(value);
  return (
    <span className="block truncate" title={text.length > 40 ? text : undefined}>
      {text}
    </span>
  );
}
