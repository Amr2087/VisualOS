import { ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ImagePlus,
  Layers3,
  Loader2,
  PackagePlus,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  UploadCloud
} from "lucide-react";

type ImageMode = "photoshoot" | "flat_lay";
type ProductStatus = "draft" | "generated" | "approved" | "published" | "error";

type ProductSizeInventory = {
  id: string;
  size: string;
  quantity: string;
};

type ProductCard = {
  id: string;
  sku: string;
  title: string;
  description: string;
  price: string;
  branch: string;
  hints: string;
  imageMode: ImageMode;
  autoMetadata: boolean;
  files: File[];
  sizes: ProductSizeInventory[];
  generatedImageBase64: string;
  generatedImageMimeType: string;
  refinedPrompt: string;
  status: ProductStatus;
  error: string;
  publishResult?: BatchPublishItemResult;
};

type GenerateImageResult = {
  image_mode: ImageMode;
  refined_prompt: string;
  reference_mapping: string;
  mime_type: string;
  image_base64: string;
};

type MetadataResult = {
  title: string;
  description: string;
};

type BatchPublishItemResult = {
  local_id: string;
  ok: boolean;
  status_code?: number;
  error?: unknown;
  product?: {
    id?: string;
    title?: string;
    onlineStoreUrl?: string | null;
    onlineStorePreviewUrl?: string | null;
  };
  variant_count?: number;
  media_status?: string;
  inventory_status?: string;
};

type BatchPublishResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchPublishItemResult[];
};

const MAX_REFERENCE_SIDE = 1280;
const REFERENCE_JPEG_QUALITY = 0.84;

function makeId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSizeInventory(size = "", quantity = ""): ProductSizeInventory {
  return { id: makeId(), size, quantity };
}

function createProductCard(autoMetadata = true): ProductCard {
  return {
    id: makeId(),
    sku: "",
    title: "",
    description: "",
    price: "",
    branch: "",
    hints: "",
    imageMode: "photoshoot",
    autoMetadata,
    files: [],
    sizes: [createSizeInventory()],
    generatedImageBase64: "",
    generatedImageMimeType: "image/png",
    refinedPrompt: "",
    status: "draft",
    error: ""
  };
}

function normalizeShopDomain(value: string) {
  const rawValue = value.trim().toLowerCase();
  if (!rawValue) return "";
  try {
    const url = new URL(rawValue.includes("://") ? rawValue : `https://${rawValue}`);
    return url.hostname.replace(/\.$/, "");
  } catch {
    return rawValue.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
  }
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : { detail: await response.text() };
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : prettyJson(data.detail));
  }
  return data;
}

async function postForm<T>(url: string, formData: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body: formData });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : { detail: await response.text() };
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : prettyJson(data.detail));
  }
  return data;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not read ${file.name} as an image.`));
    };
    image.src = url;
  });
}

async function prepareImageForUpload(file: File): Promise<File> {
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_REFERENCE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare image compression.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (nextBlob) => {
        if (nextBlob) resolve(nextBlob);
        else reject(new Error(`Could not compress ${file.name}.`));
      },
      "image/jpeg",
      REFERENCE_JPEG_QUALITY
    );
  });
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
    type: "image/jpeg",
    lastModified: file.lastModified
  });
}

function dataUrl(product: ProductCard) {
  if (!product.generatedImageBase64) return "";
  return `data:${product.generatedImageMimeType};base64,${product.generatedImageBase64}`;
}

export function App() {
  const [products, setProducts] = useState<ProductCard[]>(() => [createProductCard()]);
  const [batchAutoMetadata, setBatchAutoMetadata] = useState(true);
  const [shopDomain, setShopDomain] = useState(() => window.localStorage.getItem("visualos-shopify-domain") || "");
  const [clientId, setClientId] = useState(() => window.sessionStorage.getItem("visualos-shopify-client-id") || "");
  const [clientSecret, setClientSecret] = useState(() => window.sessionStorage.getItem("visualos-shopify-client-secret") || "");
  const [legacyToken, setLegacyToken] = useState(() => window.sessionStorage.getItem("visualos-shopify-admin-token") || "");
  const [apiVersion, setApiVersion] = useState(() => window.sessionStorage.getItem("visualos-shopify-admin-api-version") || "2026-04");
  const [locationId, setLocationId] = useState(() => window.sessionStorage.getItem("visualos-shopify-location-id") || "");
  const [publicationId, setPublicationId] = useState(() => window.sessionStorage.getItem("visualos-shopify-publication-id") || "");
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [lastPublishResult, setLastPublishResult] = useState<BatchPublishResult | null>(null);

  const approvedCount = products.filter((product) => product.status === "approved").length;
  const generatedCount = products.filter((product) => product.generatedImageBase64).length;
  const readyToPublish = products.filter((product) => product.status === "approved" && product.generatedImageBase64);

  useEffect(() => {
    window.localStorage.setItem("visualos-shopify-domain", normalizeShopDomain(shopDomain));
  }, [shopDomain]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-client-id", clientId);
  }, [clientId]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-client-secret", clientSecret);
  }, [clientSecret]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-admin-token", legacyToken);
  }, [legacyToken]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-admin-api-version", apiVersion);
  }, [apiVersion]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-location-id", locationId);
  }, [locationId]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-publication-id", publicationId);
  }, [publicationId]);

  function patchProduct(id: string, patch: Partial<ProductCard>) {
    setProducts((current) => current.map((product) => (product.id === id ? { ...product, ...patch } : product)));
  }

  function addProduct() {
    setProducts((current) => [...current, createProductCard(batchAutoMetadata)]);
  }

  function removeProduct(id: string) {
    setProducts((current) => (current.length > 1 ? current.filter((product) => product.id !== id) : current));
  }

  function addSize(productId: string) {
    setProducts((current) =>
      current.map((product) =>
        product.id === productId ? { ...product, sizes: [...product.sizes, createSizeInventory()] } : product
      )
    );
  }

  function patchSize(productId: string, rowId: string, patch: Partial<ProductSizeInventory>) {
    setProducts((current) =>
      current.map((product) =>
        product.id === productId
          ? { ...product, sizes: product.sizes.map((row) => (row.id === rowId ? { ...row, ...patch } : row)) }
          : product
      )
    );
  }

  function removeSize(productId: string, rowId: string) {
    setProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;
        const nextSizes = product.sizes.filter((row) => row.id !== rowId);
        return { ...product, sizes: nextSizes.length ? nextSizes : [createSizeInventory()] };
      })
    );
  }

  function productValidation(product: ProductCard) {
    if (!product.sku.trim()) return "SKU is required.";
    if (!product.files.length) return "Upload at least one product image.";
    if (product.price.trim() && Number.isNaN(Number(product.price))) return "Price must be numeric.";
    if (product.sizes.some((row) => row.quantity.trim() && Number.isNaN(Number(row.quantity)))) return "Quantities must be numeric.";
    return "";
  }

  async function generateProduct(product: ProductCard) {
    const validation = productValidation(product);
    if (validation) {
      patchProduct(product.id, { error: validation, status: "error" });
      return;
    }

    setActiveProductId(product.id);
    patchProduct(product.id, { error: "", status: "draft" });
    try {
      const formData = new FormData();
      formData.set("sku", product.sku);
      formData.set("image_mode", product.imageMode);
      formData.set("user_hints", product.hints);
      formData.set("size", "1K");
      formData.set("aspect_ratio", "1:1");
      for (const file of product.files) {
        formData.append("product_images", await prepareImageForUpload(file));
      }
      const imageResult = await postForm<GenerateImageResult>("/api/products/generate-image", formData);
      let nextPatch: Partial<ProductCard> = {
        generatedImageBase64: imageResult.image_base64,
        generatedImageMimeType: imageResult.mime_type,
        refinedPrompt: imageResult.refined_prompt,
        status: "generated",
        error: ""
      };

      if (product.autoMetadata) {
        const metadata = await postJson<MetadataResult>("/api/products/generate-metadata", {
          image_base64: imageResult.image_base64,
          mime_type: imageResult.mime_type,
          sku: product.sku,
          hints: product.hints
        });
        nextPatch = {
          ...nextPatch,
          title: metadata.title || product.title,
          description: metadata.description || product.description
        };
      }
      patchProduct(product.id, nextPatch);
    } catch (error) {
      patchProduct(product.id, {
        status: "error",
        error: error instanceof Error ? error.message : "Generation failed."
      });
    } finally {
      setActiveProductId(null);
    }
  }

  async function generateAll() {
    for (const product of products) {
      await generateProduct(product);
    }
  }

  function approveProduct(id: string) {
    const product = products.find((item) => item.id === id);
    if (!product) return;
    const validation = productValidation(product);
    if (validation || !product.generatedImageBase64 || !product.title.trim()) {
      patchProduct(id, {
        status: "error",
        error: validation || (!product.generatedImageBase64 ? "Generate an image before approval." : "Title is required before approval.")
      });
      return;
    }
    patchProduct(id, { status: "approved", error: "" });
  }

  function approveAll() {
    products.forEach((product) => approveProduct(product.id));
  }

  function publishPayload() {
    return readyToPublish.map((product) => ({
      id: product.id,
      generated_image_base64: product.generatedImageBase64,
      generated_image_mime_type: product.generatedImageMimeType,
      title: product.title.trim(),
      description: product.description.trim(),
      sku: product.sku.trim(),
      branch: product.branch.trim() || null,
      price: product.price.trim() ? Number(product.price) : null,
      sizes: product.sizes
        .filter((row) => row.size.trim())
        .map((row) => ({ size: row.size.trim(), qty: Number(row.quantity || 0) }))
    }));
  }

  async function publishApproved() {
    const normalizedShop = normalizeShopDomain(shopDomain);
    if (!normalizedShop) {
      setGlobalError("Enter your Shopify store domain first.");
      return;
    }
    if (!readyToPublish.length) {
      setGlobalError("Approve at least one generated product first.");
      return;
    }

    setIsPublishing(true);
    setGlobalError("");
    setLastPublishResult(null);
    try {
      const result = await postJson<BatchPublishResult>("/api/products/publish-batch", {
        shop_domain: normalizedShop,
        shopify_client_id: clientId.trim() || undefined,
        shopify_client_secret: clientSecret.trim() || undefined,
        admin_access_token: legacyToken.trim() || undefined,
        admin_api_version: apiVersion.trim() || undefined,
        location_id: locationId.trim() || undefined,
        publication_id: publicationId.trim() || undefined,
        products: publishPayload()
      });
      setLastPublishResult(result);
      setProducts((current) =>
        current.map((product) => {
          const itemResult = result.results.find((item) => item.local_id === product.id);
          if (!itemResult) return product;
          return {
            ...product,
            status: itemResult.ok ? "published" : "error",
            error: itemResult.ok ? "" : prettyJson(itemResult.error),
            publishResult: itemResult
          };
        })
      );
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Batch publish failed.");
    } finally {
      setIsPublishing(false);
    }
  }

  async function copyBatchJson() {
    await navigator.clipboard.writeText(prettyJson(publishPayload()));
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">VisualOS Shopify Assistant</p>
          <h1>Bulk product creation</h1>
        </div>
        <div className="topbar-stats">
          <span>{products.length} products</span>
          <span>{generatedCount} generated</span>
          <span>{approvedCount} approved</span>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <section className="surface">
            <div className="section-heading">
              <Settings2 size={18} />
              <h2>Shopify</h2>
            </div>
            <label className="field">
              <span>Store domain</span>
              <input value={shopDomain} onChange={(event) => setShopDomain(event.target.value)} placeholder="store.myshopify.com" />
            </label>
            <label className="field">
              <span>Client ID</span>
              <input value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Dev Dashboard client ID" />
            </label>
            <label className="field">
              <span>Client Secret</span>
              <input
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Dev Dashboard client secret"
              />
            </label>
            <label className="field">
              <span>Legacy Admin token</span>
              <input
                type="password"
                value={legacyToken}
                onChange={(event) => setLegacyToken(event.target.value)}
                placeholder="Optional shpat_..."
              />
            </label>
            <div className="two-col">
              <label className="field">
                <span>API version</span>
                <input value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} />
              </label>
              <label className="field">
                <span>Location</span>
                <input value={locationId} onChange={(event) => setLocationId(event.target.value)} placeholder="GID or exact name for stock" />
              </label>
            </div>
            <label className="field">
              <span>Publication ID</span>
              <input value={publicationId} onChange={(event) => setPublicationId(event.target.value)} placeholder="Optional gid://..." />
            </label>
          </section>

          <section className="surface">
            <div className="section-heading">
              <Layers3 size={18} />
              <h2>Batch</h2>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={batchAutoMetadata}
                onChange={(event) => {
                  setBatchAutoMetadata(event.target.checked);
                  setProducts((current) => current.map((product) => ({ ...product, autoMetadata: event.target.checked })));
                }}
              />
              <span>Generate title and description</span>
            </label>
            <div className="stack-actions">
              <button className="secondary-button" type="button" onClick={addProduct}>
                <Plus size={16} />
                Add product
              </button>
              <button className="secondary-button" type="button" onClick={generateAll} disabled={Boolean(activeProductId)}>
                {activeProductId ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                Generate all
              </button>
              <button className="secondary-button" type="button" onClick={approveAll}>
                <CheckCircle2 size={16} />
                Approve all
              </button>
              <button className="secondary-button" type="button" onClick={copyBatchJson} disabled={!readyToPublish.length}>
                <Copy size={16} />
                Copy publish JSON
              </button>
              <button className="primary-button" type="button" onClick={publishApproved} disabled={isPublishing || !readyToPublish.length}>
                {isPublishing ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
                Publish approved
              </button>
            </div>
            {globalError && <div className="error-box">{globalError}</div>}
            {!locationId.trim() && (
              <div className="warning-box">
                Stock needs a Shopify Location GID or exact location name. Without it, products publish but inventory is skipped.
              </div>
            )}
            {lastPublishResult && (
              <div className="result-note">
                Published {lastPublishResult.succeeded} of {lastPublishResult.total}; {lastPublishResult.failed} failed.
              </div>
            )}
          </section>
        </aside>

        <section className="product-grid">
          {products.map((product, index) => (
            <article className="product-card" key={product.id}>
              <div className="product-card-header">
                <div>
                  <span className={`status-pill ${product.status}`}>{product.status}</span>
                  <h2>Product {index + 1}</h2>
                </div>
                <button className="icon-button danger" type="button" onClick={() => removeProduct(product.id)} title="Remove product">
                  <Trash2 size={16} />
                </button>
              </div>

              <div className="image-zone">
                {product.generatedImageBase64 ? (
                  <img src={dataUrl(product)} alt={`${product.sku || "Generated"} product`} />
                ) : (
                  <div className="image-placeholder">
                    <ImagePlus size={28} />
                    <span>Generated image</span>
                  </div>
                )}
              </div>

              <div className="mode-switch">
                <button
                  className={product.imageMode === "photoshoot" ? "active" : ""}
                  type="button"
                  onClick={() => patchProduct(product.id, { imageMode: "photoshoot" })}
                >
                  Photoshoot
                </button>
                <button
                  className={product.imageMode === "flat_lay" ? "active" : ""}
                  type="button"
                  onClick={() => patchProduct(product.id, { imageMode: "flat_lay" })}
                >
                  Flat lay
                </button>
              </div>

              <label className="upload-box">
                <UploadCloud size={18} />
                <span>{product.files.length ? `${product.files.length} image(s) selected` : "Upload product images"}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    patchProduct(product.id, { files: Array.from(event.target.files || []), error: "" })
                  }
                />
              </label>

              <div className="form-grid">
                <label className="field">
                  <span>SKU</span>
                  <input value={product.sku} onChange={(event) => patchProduct(product.id, { sku: event.target.value })} />
                </label>
                <label className="field">
                  <span>Price</span>
                  <input value={product.price} onChange={(event) => patchProduct(product.id, { price: event.target.value })} />
                </label>
                <label className="field">
                  <span>Branch</span>
                  <input
                    value={product.branch}
                    onChange={(event) => patchProduct(product.id, { branch: event.target.value })}
                    placeholder="Optional branch or Location GID"
                  />
                </label>
              </div>

              <label className="field">
                <span>Generation notes</span>
                <textarea
                  value={product.hints}
                  onChange={(event) => patchProduct(product.id, { hints: event.target.value })}
                  rows={2}
                  placeholder="Colorway, angle, styling, brand-safe notes..."
                />
              </label>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={product.autoMetadata}
                  onChange={(event) => patchProduct(product.id, { autoMetadata: event.target.checked })}
                />
                <span>Generate title and description</span>
              </label>

              <div className="size-editor">
                <div className="size-editor-heading">
                  <span>Size inventory</span>
                  <button className="text-button" type="button" onClick={() => addSize(product.id)}>
                    <Plus size={14} />
                    Add size
                  </button>
                </div>
                {product.sizes.map((row) => (
                  <div className="size-row" key={row.id}>
                    <input value={row.size} onChange={(event) => patchSize(product.id, row.id, { size: event.target.value })} placeholder="Size" />
                    <input
                      value={row.quantity}
                      onChange={(event) => patchSize(product.id, row.id, { quantity: event.target.value })}
                      placeholder="Qty"
                    />
                    <button className="icon-button" type="button" onClick={() => removeSize(product.id, row.id)} title="Remove size">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <label className="field">
                <span>Title</span>
                <input value={product.title} onChange={(event) => patchProduct(product.id, { title: event.target.value })} />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea
                  value={product.description}
                  onChange={(event) => patchProduct(product.id, { description: event.target.value })}
                  rows={4}
                />
              </label>

              {product.refinedPrompt && (
                <details>
                  <summary>Refined prompt</summary>
                  <p>{product.refinedPrompt}</p>
                </details>
              )}

              {product.error && <div className="error-box">{product.error}</div>}
              {product.publishResult?.ok && (
                <div className="publish-result">
                  <PackagePlus size={16} />
                  <span>
                    Shopify product created. Inventory {product.publishResult.inventory_status || "unknown"}.
                    {product.publishResult.product?.onlineStorePreviewUrl && (
                      <a href={product.publishResult.product.onlineStorePreviewUrl} target="_blank" rel="noreferrer">
                        Preview
                      </a>
                    )}
                  </span>
                </div>
              )}

              <div className="card-actions">
                <button className="secondary-button" type="button" onClick={() => generateProduct(product)} disabled={activeProductId === product.id}>
                  {activeProductId === product.id ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                  Generate
                </button>
                <button className="primary-button" type="button" onClick={() => approveProduct(product.id)}>
                  <CheckCircle2 size={16} />
                  Approve
                </button>
              </div>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}

export default App;
