import { useRef, useState } from "react";
import { BookOpen, Download, Package, Pencil, Plus, Share2, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, Tbody, Td, Th, Thead, Tr } from "@/components/ui/table";
import { EmptyState, Section, formatters } from "./common";
import { PriceBookEditor } from "./PriceBookEditor";
import { ProductEditor } from "./ProductEditor";
import { api, type Shareable } from "@/lib/api";
import type { Preferences } from "@/lib/preferences";
import type { PriceBook, Product } from "@/lib/types";
import type { PriceBookInput, ProductInput } from "@/lib/validate";

type Props = {
  products: Product[];
  priceBooks: PriceBook[];
  preferences: Preferences;
  myId: string;
  onChanged: () => Promise<void>;
  onShare: (kind: Shareable, id: string, title: string) => void;
  onError: (error: unknown) => void;
  onNotice: (lines: string[]) => void;
  confirmed: (message: string) => boolean;
};

/**
 * The catalogue: what is sold, and what it costs in each price book.
 *
 * Products and price books share a screen because they are edited together —
 * a new product needs a price, and a price book is meaningless without the
 * products it prices.
 */
export function CatalogView(props: Props) {
  const { products, priceBooks, preferences, myId } = props;
  const [editingProduct, setEditingProduct] = useState<Product | null | undefined>(undefined);
  const [editingBook, setEditingBook] = useState<PriceBook | null | undefined>(undefined);
  const importRef = useRef<HTMLInputElement>(null);

  const format = formatters(preferences.defaultCurrency, preferences.locale);

  const saveProduct = async (input: ProductInput) => {
    if (editingProduct) await api.updateProduct(editingProduct.id, input);
    else await api.createProduct(input);
    await props.onChanged();
    setEditingProduct(undefined);
  };

  const saveBook = async (input: PriceBookInput) => {
    if (editingBook) await api.updatePriceBook(editingBook.id, input);
    else await api.createPriceBook(input);
    await props.onChanged();
    setEditingBook(undefined);
  };

  const removeProduct = async (product: Product) => {
    if (!props.confirmed(`Delete ${product.sku}? Quotes that already use it keep the price they were given.`)) return;
    try {
      await api.deleteProduct(product.id);
      await props.onChanged();
    } catch (error) {
      props.onError(error);
    }
  };

  const removeBook = async (book: PriceBook) => {
    if (!props.confirmed(`Delete the price book “${book.name}”?`)) return;
    try {
      await api.deletePriceBook(book.id);
      await props.onChanged();
    } catch (error) {
      props.onError(error);
    }
  };

  /** Importing a `*.cpq.json` file: read it here, validate on the server. */
  const importFile = async (file: File) => {
    try {
      const report = await api.importCatalog(JSON.parse(await file.text()));
      await props.onChanged();
      const created = Object.entries(report.created)
        .map(([what, count]) => `${count} ${what}`)
        .join(", ");
      props.onNotice([
        created ? `Imported ${created}.` : "Nothing new to import — everything in that file is already here.",
        ...(report.skipped.length ? [`Left alone, already present: ${report.skipped.join(", ")}.`] : []),
        ...report.warnings,
      ]);
    } catch (error) {
      props.onError(error);
    }
  };

  return (
    <div className="space-y-4">
      <Section
        title="Products"
        description={`${products.length} product${products.length === 1 ? "" : "s"}`}
        actions={
          <>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
            <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>
              <Upload /> Import
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={api.catalogExportUrl} title="Products, price books and rules as one file">
                <Download /> Export
              </a>
            </Button>
            <Button size="sm" onClick={() => setEditingProduct(null)}>
              <Plus /> New product
            </Button>
          </>
        }
      >
        {products.length === 0 ? (
          <EmptyState title="The catalogue is empty">
            Add a product, import a <code>*.cpq.json</code> file, or install the worked example from Settings.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Product</Th>
                <Th>Family</Th>
                <Th>Billing</Th>
                <Th numeric>List</Th>
                <Th numeric>Margin</Th>
                <Th>Shape</Th>
                <Th className="w-28" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {products.map(product => {
                const mine = product.ownerId === myId;
                const margin = product.listPrice ? ((product.listPrice - product.cost) / product.listPrice) * 100 : 0;

                return (
                  <Tr key={product.id} className={product.active ? undefined : "opacity-60"}>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Package className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{product.name}</span>
                        <span className="font-mono text-xs text-muted-foreground">{product.sku}</span>
                        {!product.active && <Badge tone="neutral">inactive</Badge>}
                        {!mine && <Badge tone="info">shared with you</Badge>}
                      </div>
                      {product.description && (
                        <p className="line-clamp-1 text-xs text-muted-foreground">{product.description}</p>
                      )}
                    </Td>
                    <Td className="text-muted-foreground">{product.family || "—"}</Td>
                    <Td className="text-muted-foreground">
                      {product.chargeType === "recurring" ? product.billingPeriod : product.chargeType}
                    </Td>
                    <Td numeric>
                      {format.money(product.listPrice, product.currency)}
                      <span className="block text-xs text-muted-foreground">per {product.unitOfMeasure}</span>
                    </Td>
                    <Td numeric className="text-muted-foreground">
                      {format.percent(margin)}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {product.optionGroups.length > 0 && (
                          <Badge tone="outline">{product.optionGroups.length} option groups</Badge>
                        )}
                        {product.volumeTiers.length > 0 && <Badge tone="outline">{product.volumeTiers.length} tiers</Badge>}
                        {product.rules.length > 0 && <Badge tone="outline">{product.rules.length} rules</Badge>}
                        {product.components.length > 0 && <Badge tone="info">bundle</Badge>}
                      </div>
                    </Td>
                    <Td>
                      <div className="flex justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditingProduct(product)}
                          aria-label={`Edit ${product.name}`}
                        >
                          <Pencil />
                        </Button>
                        {mine && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => props.onShare("products", product.id, product.name)}
                              aria-label={`Share ${product.name}`}
                            >
                              <Share2 />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => void removeProduct(product)}
                              aria-label={`Delete ${product.name}`}
                            >
                              <Trash2 className="text-muted-foreground hover:text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Section>

      <Section
        title="Price books"
        description="What a product costs a particular customer, and the floor nothing may go below."
        actions={
          <Button size="sm" onClick={() => setEditingBook(null)}>
            <Plus /> New price book
          </Button>
        }
      >
        {priceBooks.length === 0 ? (
          <EmptyState title="No price books">
            Without one, every quote is priced straight off the catalogue's list price.
          </EmptyState>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Currency</Th>
                <Th numeric>Entries</Th>
                <Th>Valid</Th>
                <Th className="w-28" aria-label="Actions" />
              </Tr>
            </Thead>
            <Tbody>
              {priceBooks.map(book => (
                <Tr key={book.id} className={book.active ? undefined : "opacity-60"}>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{book.name}</span>
                      {book.isDefault && <Badge tone="success">default</Badge>}
                      {!book.active && <Badge tone="neutral">inactive</Badge>}
                      {book.ownerId !== myId && <Badge tone="info">shared with you</Badge>}
                    </div>
                    {book.description && <p className="line-clamp-1 text-xs text-muted-foreground">{book.description}</p>}
                  </Td>
                  <Td className="text-muted-foreground">{book.currency}</Td>
                  <Td numeric className="text-muted-foreground">
                    {book.entries.length}
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {book.validFrom || book.validTo ? `${book.validFrom || "—"} → ${book.validTo || "—"}` : "Always"}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditingBook(book)} aria-label={`Edit ${book.name}`}>
                        <Pencil />
                      </Button>
                      {book.ownerId === myId && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => props.onShare("price-books", book.id, book.name)}
                            aria-label={`Share ${book.name}`}
                          >
                            <Share2 />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => void removeBook(book)}
                            aria-label={`Delete ${book.name}`}
                          >
                            <Trash2 className="text-muted-foreground hover:text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Section>

      {editingProduct !== undefined && (
        <ProductEditor
          product={editingProduct}
          products={products}
          onSave={saveProduct}
          onClose={() => setEditingProduct(undefined)}
        />
      )}

      {editingBook !== undefined && (
        <PriceBookEditor
          book={editingBook}
          products={products}
          onSave={saveBook}
          onClose={() => setEditingBook(undefined)}
        />
      )}
    </div>
  );
}
