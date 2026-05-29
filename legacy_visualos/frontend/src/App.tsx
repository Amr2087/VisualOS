import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  Download,
  Edit3,
  FolderOpen,
  ImagePlus,
  Loader2,
  Plus,
  PlugZap,
  Save,
  Send,
  ShoppingBag,
  Sparkles,
  Store,
  Trash2,
  Upload
} from "lucide-react";

type StyleOption = {
  label: string;
  subtitle?: string;
  description?: string;
};

type ConfigCategory = {
  label: string;
  description: string;
  options: Record<string, StyleOption>;
};

type StyleConfig = {
  photoshootConfig: Record<string, ConfigCategory>;
};

type GenerateResult = {
  refined_prompt: string;
  reference_mapping: string;
  mime_type: string;
  image_base64: string;
};

type FileWithRelativePath = File & {
  webkitRelativePath?: string;
};

type Page = "create" | "shopify";
type ShopifyTool =
  | "search_catalog"
  | "lookup_catalog"
  | "get_product"
  | "search_shop_policies_and_faqs"
  | "get_cart"
  | "update_cart";

type ShopifyMcpResult = {
  shop_domain?: string;
  tool?: string;
  endpoint?: string;
  endpoint_type?: string;
  status_code?: number;
  ok?: boolean;
  parsed?: unknown;
  response?: unknown;
  standard?: unknown;
  ucp?: unknown;
};

type ShopifyMoney = {
  amount?: number;
  currency?: string;
};

type ParsedShopifyVariant = {
  id?: string;
  sku?: string;
  title?: string;
  price?: ShopifyMoney;
  availability?: {
    available?: boolean;
  };
  options?: Array<{
    name?: string;
    label?: string;
  }>;
  media?: Array<{
    type?: string;
    url?: string;
  }>;
  checkout_url?: string;
};

type ParsedShopifyProduct = {
  id?: string;
  title?: string;
  description?: {
    html?: string;
  };
  url?: string;
  handle?: string;
  price_range?: {
    min?: ShopifyMoney;
    max?: ShopifyMoney;
  };
  variants?: ParsedShopifyVariant[];
  media?: Array<{
    type?: string;
    url?: string;
  }>;
  tags?: string[];
  collections?: Array<{
    title?: string;
    handle?: string;
  }>;
};

type ParsedShopifyMcpPayload = {
  ucp?: {
    version?: string;
    status?: string;
  };
  products?: ParsedShopifyProduct[];
  pagination?: {
    has_next_page?: boolean;
    cursor?: string;
  };
  messages?: unknown[];
};

type ProductSizeInventory = {
  id: string;
  size: string;
  quantity: string;
};

type ProductDraft = {
  id: string;
  img: string;
  desc: string;
  title: string;
  sku: string;
  branch: string;
  price: string;
  sizes: ProductSizeInventory[];
};

type ProductDraftPayload = {
  img: string;
  desc: string;
  title: string;
  sku: string;
  branch: string | null;
  price: number | null;
  sizes: Array<{
    size: string;
    qty: number;
  }>;
};

type ShopifyAdminProductPublishResult = {
  product?: {
    id?: string;
    title?: string;
    onlineStoreUrl?: string | null;
    onlineStorePreviewUrl?: string | null;
  };
  published?: boolean;
  publication_configured?: boolean;
  location_id?: string | null;
};

const fieldLabels: Record<string, string> = {
  style_genre: "Style / Genre",
  moodboard_grading: "Moodboard / Grading",
  framing: "Framing",
  camera_angle: "Camera Angle",
  lens_focal_length: "Lens / Focal Length",
  lighting_setup: "Lighting Setup",
  environment_setting: "Environment"
};

const defaultPrompt =
  "Create a full-body editorial fashion image. Use (model) as the person reference and use the product references as the wardrobe pieces. Preserve the products' shapes, materials, colors, and styling details while creating a realistic premium photoshoot.";

const folderUploadProps = { webkitdirectory: "" };
const MAX_UPLOAD_BYTES = 4_200_000;
const MAX_REFERENCE_SIDE = 1280;
const REFERENCE_JPEG_QUALITY = 0.82;
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const PRODUCT_DRAFTS_STORAGE_KEY = "visualos-shopify-product-drafts";

const SHOPIFY_TOOL_CONFIG: Record<
  ShopifyTool,
  { label: string; endpoint: "standard" | "ucp"; mutates: boolean; defaultArguments: Record<string, unknown> }
> = {
  search_catalog: {
    label: "Search catalog",
    endpoint: "ucp",
    mutates: false,
    defaultArguments: { query: "shirt" }
  },
  lookup_catalog: {
    label: "Lookup catalog",
    endpoint: "ucp",
    mutates: false,
    defaultArguments: { ids: [] }
  },
  get_product: {
    label: "Get product",
    endpoint: "ucp",
    mutates: false,
    defaultArguments: { id: "" }
  },
  search_shop_policies_and_faqs: {
    label: "Search policies and FAQs",
    endpoint: "standard",
    mutates: false,
    defaultArguments: {
      query: "What is your return policy?",
      context: "Customer is browsing the store"
    }
  },
  get_cart: {
    label: "Get cart",
    endpoint: "standard",
    mutates: false,
    defaultArguments: { cart_id: "" }
  },
  update_cart: {
    label: "Update cart",
    endpoint: "standard",
    mutates: true,
    defaultArguments: {
      cart_id: "",
      add_items: [
        {
          merchandise_id: "gid://shopify/ProductVariant/REPLACE_ME",
          quantity: 1
        }
      ]
    }
  }
};

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function makeId() {
  return window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSizeInventory(size = "", quantity = ""): ProductSizeInventory {
  return {
    id: makeId(),
    size,
    quantity
  };
}

function createProductDraft(values: Partial<ProductDraft> = {}): ProductDraft {
  return {
    id: values.id || makeId(),
    img: values.img || "",
    desc: values.desc || "",
    title: values.title || "",
    sku: values.sku || "",
    branch: values.branch || "",
    price: values.price || "",
    sizes: values.sizes?.length ? values.sizes : [createSizeInventory()]
  };
}

function readProductDrafts(): ProductDraft[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PRODUCT_DRAFTS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map((draft: unknown) => {
      const draftRecord = isRecord(draft) ? draft : {};
      const sizes = Array.isArray(draftRecord.sizes)
        ? draftRecord.sizes.map((sizeRow: unknown) =>
            createSizeInventory(
              isRecord(sizeRow) && typeof sizeRow.size === "string" ? sizeRow.size : "",
              isRecord(sizeRow) && typeof sizeRow.quantity === "string" ? sizeRow.quantity : ""
            )
          )
        : [createSizeInventory()];
      return createProductDraft({ ...draftRecord, sizes });
    });
  } catch {
    return [];
  }
}

function productDraftToPayload(draft: ProductDraft): ProductDraftPayload {
  return {
    img: draft.img.trim(),
    desc: draft.desc.trim(),
    title: draft.title.trim(),
    sku: draft.sku.trim(),
    branch: draft.branch.trim() || null,
    price: draft.price.trim() ? Number(draft.price) : null,
    sizes: draft.sizes
      .filter((row) => row.size.trim())
      .map((row) => ({
        size: row.size.trim(),
        qty: Number(row.quantity || 0)
      }))
  };
}

function stemName(file: FileWithRelativePath) {
  const filename = file.webkitRelativePath || file.name;
  const clean = filename.split("/").pop() || filename;
  return clean.replace(/\.[^.]+$/, "");
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

async function prepareImageForUpload(file: FileWithRelativePath): Promise<FileWithRelativePath> {
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_REFERENCE_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not prepare image compression.");
  }
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

  const compressedName = `${stemName(file)}.jpg`;
  return new File([blob], compressedName, {
    type: "image/jpeg",
    lastModified: file.lastModified
  }) as FileWithRelativePath;
}

function totalBytes(files: File[]) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function pageFromPath(pathname: string): Page {
  return pathname.endsWith("/shopify") ? "shopify" : "create";
}

function pathForPage(page: Page) {
  const localBase = window.location.pathname.startsWith("/frontend") ? "/frontend" : "";
  return page === "shopify" ? `${localBase}/shopify` : `${localBase}/`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asShopifyPayload(value: unknown): ParsedShopifyMcpPayload | null {
  if (!isRecord(value)) return null;
  if (Array.isArray(value.products) || isRecord(value.pagination) || isRecord(value.ucp)) {
    return value as ParsedShopifyMcpPayload;
  }
  return null;
}

function parseRpcPayload(value: unknown): ParsedShopifyMcpPayload | null {
  const directPayload = asShopifyPayload(value);
  if (directPayload) return directPayload;
  if (!isRecord(value) || !isRecord(value.result)) return null;

  const structuredPayload = asShopifyPayload(value.result.structuredContent);
  if (structuredPayload) return structuredPayload;

  const content = value.result.content;
  if (!Array.isArray(content)) return null;

  for (const part of content) {
    if (!isRecord(part) || typeof part.text !== "string") continue;
    try {
      const parsed = JSON.parse(part.text);
      const textPayload = asShopifyPayload(parsed);
      if (textPayload) return textPayload;
    } catch {
      // Some text parts are plain prose rather than embedded JSON.
    }
  }

  return null;
}

function parseShopifyPayload(result: ShopifyMcpResult | null): ParsedShopifyMcpPayload | null {
  if (!result) return null;
  return (
    asShopifyPayload(result.parsed) ||
    parseRpcPayload(result.response) ||
    parseRpcPayload(result.ucp) ||
    parseRpcPayload(result.standard)
  );
}

function stripHtml(html?: string) {
  return (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function formatMoney(value?: ShopifyMoney) {
  if (!value || typeof value.amount !== "number") return "";
  return `${value.amount.toLocaleString()} ${value.currency || ""}`.trim();
}

function priceRangeLabel(product: ParsedShopifyProduct) {
  const minPrice = formatMoney(product.price_range?.min);
  const maxPrice = formatMoney(product.price_range?.max);
  if (!minPrice && !maxPrice) return "No price";
  if (!maxPrice || minPrice === maxPrice) return minPrice;
  return `${minPrice} - ${maxPrice}`;
}

function firstProductImage(product: ParsedShopifyProduct) {
  const productImage = product.media?.find((media) => media.type === "image" && media.url)?.url;
  if (productImage) return productImage;

  for (const variant of product.variants || []) {
    const variantImage = variant.media?.find((media) => media.type === "image" && media.url)?.url;
    if (variantImage) return variantImage;
  }

  return "";
}

function SelectField({
  id,
  category,
  value,
  onChange
}: {
  id: string;
  category: ConfigCategory;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{fieldLabels[id] || category.label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {Object.entries(category.options).map(([key, option]) => (
          <option key={key} value={key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FileList({ title, files }: { title: string; files: FileWithRelativePath[] }) {
  if (!files.length) return null;

  return (
    <div className="file-list">
      <div className="file-list-title">{title}</div>
      {files.map((file) => (
        <div className="file-row" key={`${file.name}-${file.lastModified}`}>
          <span>({stemName(file)})</span>
          <small>{file.webkitRelativePath || file.name}</small>
        </div>
      ))}
    </div>
  );
}

function ShopifyMcpPage() {
  const [shopInput, setShopInput] = useState(() => window.localStorage.getItem("visualos-shopify-domain") || "");
  const [shopDomain, setShopDomain] = useState(() => normalizeShopDomain(window.localStorage.getItem("visualos-shopify-domain") || ""));
  const [selectedTool, setSelectedTool] = useState<ShopifyTool>("search_catalog");
  const [argumentsJson, setArgumentsJson] = useState(prettyJson(SHOPIFY_TOOL_CONFIG.search_catalog.defaultArguments));
  const [result, setResult] = useState<ShopifyMcpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [productDraft, setProductDraft] = useState<ProductDraft>(() => createProductDraft());
  const [productDrafts, setProductDrafts] = useState<ProductDraft[]>(() => readProductDrafts());
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [productEditorError, setProductEditorError] = useState<string | null>(null);
  const [publishingDraftId, setPublishingDraftId] = useState<string | null>(null);
  const [publishResults, setPublishResults] = useState<Record<string, ShopifyAdminProductPublishResult>>({});
  const [shopifyClientId, setShopifyClientId] = useState(() => window.sessionStorage.getItem("visualos-shopify-client-id") || "");
  const [shopifyClientSecret, setShopifyClientSecret] = useState(
    () => window.sessionStorage.getItem("visualos-shopify-client-secret") || ""
  );
  const [adminToken, setAdminToken] = useState(() => window.sessionStorage.getItem("visualos-shopify-admin-token") || "");
  const [adminApiVersion, setAdminApiVersion] = useState(
    () => window.sessionStorage.getItem("visualos-shopify-admin-api-version") || "2026-04"
  );
  const [adminLocationId, setAdminLocationId] = useState(() => window.sessionStorage.getItem("visualos-shopify-location-id") || "");
  const [adminPublicationId, setAdminPublicationId] = useState(
    () => window.sessionStorage.getItem("visualos-shopify-publication-id") || ""
  );

  const standardEndpoint = shopDomain ? `https://${shopDomain}/api/mcp` : "";
  const ucpEndpoint = shopDomain ? `https://${shopDomain}/api/ucp/mcp` : "";
  const toolConfig = SHOPIFY_TOOL_CONFIG[selectedTool];
  const parsedPayload = useMemo(() => parseShopifyPayload(result), [result]);
  const parsedProducts = parsedPayload?.products || [];
  const productDraftPayloads = useMemo(() => productDrafts.map(productDraftToPayload), [productDrafts]);

  useEffect(() => {
    window.localStorage.setItem(PRODUCT_DRAFTS_STORAGE_KEY, JSON.stringify(productDrafts));
  }, [productDrafts]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-client-id", shopifyClientId);
  }, [shopifyClientId]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-client-secret", shopifyClientSecret);
  }, [shopifyClientSecret]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-admin-token", adminToken);
  }, [adminToken]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-admin-api-version", adminApiVersion);
  }, [adminApiVersion]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-location-id", adminLocationId);
  }, [adminLocationId]);

  useEffect(() => {
    window.sessionStorage.setItem("visualos-shopify-publication-id", adminPublicationId);
  }, [adminPublicationId]);

  function saveDomain() {
    const normalized = normalizeShopDomain(shopInput);
    setShopDomain(normalized);
    window.localStorage.setItem("visualos-shopify-domain", normalized);
    setShopInput(normalized);
    setResult(null);
    setError(null);
  }

  function changeTool(tool: ShopifyTool) {
    setSelectedTool(tool);
    setArgumentsJson(prettyJson(SHOPIFY_TOOL_CONFIG[tool].defaultArguments));
    setResult(null);
    setError(null);
  }

  async function testConnection() {
    setError(null);
    setResult(null);
    setIsTesting(true);
    try {
      const normalized = normalizeShopDomain(shopInput || shopDomain);
      const data = await postJson<ShopifyMcpResult>("/api/shopify-mcp/test", { shop_domain: normalized });
      setShopDomain(normalized);
      window.localStorage.setItem("visualos-shopify-domain", normalized);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection test failed.");
    } finally {
      setIsTesting(false);
    }
  }

  async function callTool() {
    setError(null);
    setResult(null);
    let parsedArguments: Record<string, unknown>;
    try {
      parsedArguments = JSON.parse(argumentsJson || "{}");
    } catch {
      setError("Tool arguments must be valid JSON.");
      return;
    }

    if (toolConfig.mutates) {
      const confirmed = window.confirm("This calls update_cart and can mutate a Shopify cart. Continue?");
      if (!confirmed) return;
    }

    setIsCalling(true);
    try {
      const normalized = normalizeShopDomain(shopInput || shopDomain);
      const data = await postJson<ShopifyMcpResult>("/api/shopify-mcp/call", {
        shop_domain: normalized,
        tool: selectedTool,
        arguments: parsedArguments
      });
      setShopDomain(normalized);
      window.localStorage.setItem("visualos-shopify-domain", normalized);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Shopify MCP call failed.");
    } finally {
      setIsCalling(false);
    }
  }

  async function copyResponse() {
    if (!result) return;
    await navigator.clipboard.writeText(prettyJson(result));
  }

  function updateProductDraft(field: keyof Omit<ProductDraft, "id" | "sizes">, value: string) {
    setProductDraft((current) => ({ ...current, [field]: value }));
    setProductEditorError(null);
  }

  function updateSizeInventory(rowId: string, field: "size" | "quantity", value: string) {
    setProductDraft((current) => ({
      ...current,
      sizes: current.sizes.map((row) => (row.id === rowId ? { ...row, [field]: value } : row))
    }));
    setProductEditorError(null);
  }

  function addSizeInventory() {
    setProductDraft((current) => ({ ...current, sizes: [...current.sizes, createSizeInventory()] }));
  }

  function removeSizeInventory(rowId: string) {
    setProductDraft((current) => {
      const nextSizes = current.sizes.filter((row) => row.id !== rowId);
      return { ...current, sizes: nextSizes.length ? nextSizes : [createSizeInventory()] };
    });
  }

  function resetProductDraft() {
    setProductDraft(createProductDraft());
    setEditingProductId(null);
    setProductEditorError(null);
  }

  function saveProductDraft(event: FormEvent) {
    event.preventDefault();
    const payload = productDraftToPayload(productDraft);
    if (!payload.title) {
      setProductEditorError("Title is required.");
      return;
    }
    if (!payload.sku) {
      setProductEditorError("SKU is required.");
      return;
    }
    if (productDraft.price.trim() && Number.isNaN(payload.price)) {
      setProductEditorError("Price must be a number.");
      return;
    }
    if (payload.sizes.some((row) => Number.isNaN(row.qty))) {
      setProductEditorError("Quantity per size must be a number.");
      return;
    }

    const draftToSave = createProductDraft(productDraft);
    setProductDrafts((current) =>
      editingProductId ? current.map((draft) => (draft.id === editingProductId ? draftToSave : draft)) : [...current, draftToSave]
    );
    resetProductDraft();
  }

  function editProductDraft(draft: ProductDraft) {
    setProductDraft(createProductDraft(draft));
    setEditingProductId(draft.id);
    setProductEditorError(null);
  }

  function deleteProductDraft(draftId: string) {
    setProductDrafts((current) => current.filter((draft) => draft.id !== draftId));
    setPublishResults((current) => {
      const nextResults = { ...current };
      delete nextResults[draftId];
      return nextResults;
    });
    if (editingProductId === draftId) resetProductDraft();
  }

  async function copyProductDrafts() {
    await navigator.clipboard.writeText(prettyJson(productDraftPayloads));
  }

  async function publishProductDraft(draft: ProductDraft) {
    const normalized = normalizeShopDomain(shopInput || shopDomain);
    if (!normalized) {
      setProductEditorError("Save a Shopify store domain before pushing a product.");
      return;
    }
    const payload = productDraftToPayload(draft);
    if (!payload.title || !payload.sku) {
      setProductEditorError("Title and SKU are required before pushing.");
      return;
    }
    const confirmed = window.confirm(`Push "${payload.title}" to ${normalized}? This creates a product in Shopify Admin.`);
    if (!confirmed) return;

    setPublishingDraftId(draft.id);
    setProductEditorError(null);
    try {
      const data = await postJson<ShopifyAdminProductPublishResult>("/api/shopify-admin/products", {
        shop_domain: normalized,
        shopify_client_id: shopifyClientId.trim() || undefined,
        shopify_client_secret: shopifyClientSecret.trim() || undefined,
        admin_access_token: adminToken.trim() || undefined,
        admin_api_version: adminApiVersion.trim() || undefined,
        location_id: adminLocationId.trim() || undefined,
        publication_id: adminPublicationId.trim() || undefined,
        ...payload
      });
      setShopDomain(normalized);
      window.localStorage.setItem("visualos-shopify-domain", normalized);
      setPublishResults((current) => ({ ...current, [draft.id]: data }));
    } catch (err) {
      setProductEditorError(err instanceof Error ? err.message : "Could not push product to Shopify.");
    } finally {
      setPublishingDraftId(null);
    }
  }

  function importParsedProducts() {
    const imported = parsedProducts.map((product) => {
      const firstVariant = product.variants?.[0];
      const sizeLabels = new Map<string, string>();
      for (const variant of product.variants || []) {
        const size = variant.options?.find((option) => option.name?.toLowerCase() === "size")?.label || variant.title || "";
        if (size && !sizeLabels.has(size)) {
          sizeLabels.set(size, variant.availability?.available ? "1" : "0");
        }
      }

      return createProductDraft({
        img: firstProductImage(product),
        desc: stripHtml(product.description?.html),
        title: product.title || "",
        sku: firstVariant?.sku || "",
        price: product.price_range?.min?.amount?.toString() || firstVariant?.price?.amount?.toString() || "",
        sizes: Array.from(sizeLabels.entries()).map(([size, quantity]) => createSizeInventory(size, quantity))
      });
    });

    if (!imported.length) {
      setProductEditorError("Run a catalog search first, then import parsed products.");
      return;
    }
    setProductDrafts((current) => [...current, ...imported]);
    setProductEditorError(null);
  }

  return (
    <section className="shopify-workspace">
      <div className="surface">
        <div className="section-heading">
          <div className="heading-with-icon">
            <Store size={18} />
            <h2>Connection</h2>
          </div>
        </div>
        <div className="connection-grid">
          <label className="field">
            <span>Shopify store domain</span>
            <input
              value={shopInput}
              onChange={(event) => setShopInput(event.target.value)}
              placeholder="your-store.myshopify.com"
            />
          </label>
          <button className="secondary-button" type="button" onClick={saveDomain}>
            Save
          </button>
          <button className="secondary-button" type="button" onClick={testConnection} disabled={isTesting}>
            {isTesting ? <Loader2 className="spin" size={16} /> : <PlugZap size={16} />}
            Test
          </button>
        </div>
        <div className="endpoint-grid">
          <div>
            <span>Standard MCP</span>
            <code>{standardEndpoint || "Save a store domain to preview endpoint"}</code>
          </div>
          <div>
            <span>UCP catalog MCP</span>
            <code>{ucpEndpoint || "Save a store domain to preview endpoint"}</code>
          </div>
        </div>
        <div className="admin-credentials-grid">
          <label className="field">
            <span>Client ID</span>
            <input
              value={shopifyClientId}
              onChange={(event) => setShopifyClientId(event.target.value)}
              placeholder="Shopify Dev Dashboard client ID"
            />
          </label>
          <label className="field">
            <span>Client Secret</span>
            <input
              type="password"
              autoComplete="off"
              value={shopifyClientSecret}
              onChange={(event) => setShopifyClientSecret(event.target.value)}
              placeholder="Shopify Dev Dashboard client secret"
            />
          </label>
          <label className="field">
            <span>Legacy Admin token</span>
            <input
              type="password"
              autoComplete="off"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              placeholder="Optional shpat_..."
            />
          </label>
          <label className="field">
            <span>Admin API version</span>
            <input value={adminApiVersion} onChange={(event) => setAdminApiVersion(event.target.value)} placeholder="2026-04" />
          </label>
          <label className="field">
            <span>Location ID</span>
            <input
              value={adminLocationId}
              onChange={(event) => setAdminLocationId(event.target.value)}
              placeholder="Optional gid://shopify/Location/..."
            />
          </label>
          <label className="field">
            <span>Publication ID</span>
            <input
              value={adminPublicationId}
              onChange={(event) => setAdminPublicationId(event.target.value)}
              placeholder="Optional gid://shopify/Publication/..."
            />
          </label>
        </div>
      </div>

      <div className="surface">
        <div className="section-heading">
          <div className="heading-with-icon">
            <ImagePlus size={18} />
            <h2>Product Drafts</h2>
          </div>
          <div className="product-editor-actions">
            <button className="secondary-button" type="button" onClick={importParsedProducts} disabled={!parsedProducts.length}>
              <Download size={16} />
              Import parsed
            </button>
            <button className="secondary-button" type="button" onClick={copyProductDrafts} disabled={!productDrafts.length}>
              <Clipboard size={16} />
              Copy JSON
            </button>
          </div>
        </div>

        <form className="product-editor" onSubmit={saveProductDraft}>
          <div className="product-form-grid">
            <label className="field">
              <span>Image URL</span>
              <input
                value={productDraft.img}
                onChange={(event) => updateProductDraft("img", event.target.value)}
                placeholder="https://cdn.shopify.com/..."
              />
            </label>
            <label className="field">
              <span>Title</span>
              <input value={productDraft.title} onChange={(event) => updateProductDraft("title", event.target.value)} />
            </label>
            <label className="field">
              <span>SKU</span>
              <input value={productDraft.sku} onChange={(event) => updateProductDraft("sku", event.target.value)} />
            </label>
            <label className="field">
              <span>Branch</span>
              <input
                value={productDraft.branch}
                onChange={(event) => updateProductDraft("branch", event.target.value)}
                placeholder="Optional name, needs read_locations"
              />
            </label>
            <label className="field">
              <span>Price</span>
              <input
                inputMode="decimal"
                value={productDraft.price}
                onChange={(event) => updateProductDraft("price", event.target.value)}
                placeholder="0"
              />
            </label>
          </div>

          <label className="field product-desc-field">
            <span>Description</span>
            <textarea value={productDraft.desc} onChange={(event) => updateProductDraft("desc", event.target.value)} rows={4} />
          </label>

          <div className="size-editor">
            <div className="size-editor-heading">
              <span>Size inventory</span>
              <button className="secondary-button compact-button" type="button" onClick={addSizeInventory}>
                <Plus size={15} />
                Size
              </button>
            </div>
            {productDraft.sizes.map((row) => (
              <div className="size-row" key={row.id}>
                <label className="field">
                  <span>Size</span>
                  <input value={row.size} onChange={(event) => updateSizeInventory(row.id, "size", event.target.value)} />
                </label>
                <label className="field">
                  <span>Qty</span>
                  <input
                    inputMode="numeric"
                    value={row.quantity}
                    onChange={(event) => updateSizeInventory(row.id, "quantity", event.target.value)}
                    placeholder="0"
                  />
                </label>
                <button className="icon-button" type="button" onClick={() => removeSizeInventory(row.id)} aria-label="Remove size">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>

          {productEditorError && <div className="error-box compact-error">{productEditorError}</div>}

          <div className="product-editor-footer">
            <button className="secondary-button" type="button" onClick={resetProductDraft}>
              Reset
            </button>
            <button className="generate-button draft-save-button" type="submit">
              <Save size={18} />
              {editingProductId ? "Save changes" : "Add product"}
            </button>
          </div>
        </form>

        {productDrafts.length > 0 && (
          <div className="draft-list">
            {productDrafts.map((draft) => {
              const payload = productDraftToPayload(draft);
              const firstSize = payload.sizes[0];
              const publishResult = publishResults[draft.id];
              const productUrl = publishResult?.product?.onlineStoreUrl || publishResult?.product?.onlineStorePreviewUrl || "";
              return (
                <div className="draft-row" key={draft.id}>
                  {draft.img ? (
                    <img src={draft.img} alt={draft.title || "Product draft"} />
                  ) : (
                    <div className="draft-image-placeholder">Img</div>
                  )}
                  <div className="draft-row-main">
                    <strong>{draft.title || "Untitled product"}</strong>
                    <span>
                      {draft.sku || "No SKU"} · {payload.price ?? "No price"}
                      {payload.branch ? ` · ${payload.branch}` : ""}
                    </span>
                    <small>
                      {payload.sizes.length.toLocaleString()} sizes
                      {firstSize ? ` · ${firstSize.size}: ${firstSize.qty}` : ""}
                      {publishResult ? " · Pushed" : ""}
                    </small>
                    {productUrl && (
                      <a className="draft-product-link" href={productUrl} target="_blank" rel="noreferrer">
                        Open Shopify product
                      </a>
                    )}
                  </div>
                  <div className="draft-row-actions">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => publishProductDraft(draft)}
                      disabled={publishingDraftId === draft.id}
                    >
                      {publishingDraftId === draft.id ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
                      Push
                    </button>
                    <button className="icon-button" type="button" onClick={() => editProductDraft(draft)} aria-label="Edit product">
                      <Edit3 size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      type="button"
                      onClick={() => deleteProductDraft(draft.id)}
                      aria-label="Delete product"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="surface">
        <div className="section-heading">
          <div className="heading-with-icon">
            <ShoppingBag size={18} />
            <h2>Tool Runner</h2>
          </div>
          <div className={toolConfig.mutates ? "mutation-pill" : "status-pill"}>{toolConfig.endpoint}</div>
        </div>
        <div className="tool-grid">
          <label className="field">
            <span>Tool</span>
            <select value={selectedTool} onChange={(event) => changeTool(event.target.value as ShopifyTool)}>
              {(Object.keys(SHOPIFY_TOOL_CONFIG) as ShopifyTool[]).map((tool) => (
                <option key={tool} value={tool}>
                  {SHOPIFY_TOOL_CONFIG[tool].label}
                </option>
              ))}
            </select>
          </label>
          <label className="field tool-arguments">
            <span>Arguments JSON</span>
            <textarea value={argumentsJson} onChange={(event) => setArgumentsJson(event.target.value)} rows={10} />
          </label>
        </div>
        <button className="generate-button" type="button" onClick={callTool} disabled={isCalling}>
          {isCalling ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          {isCalling ? "Calling tool" : "Run MCP tool"}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}

      {result && (
        <div className="surface">
          <div className="result-toolbar">
            <h2>Response</h2>
            <button className="secondary-button" type="button" onClick={copyResponse}>
              <Clipboard size={16} />
              Copy
            </button>
          </div>
          {parsedPayload && (
            <div className="parsed-shopify">
              <div className="parsed-summary">
                <span>{parsedPayload.ucp?.status ? `UCP ${parsedPayload.ucp.status}` : "Parsed payload"}</span>
                {parsedPayload.ucp?.version && <span>Version {parsedPayload.ucp.version}</span>}
                <span>{parsedProducts.length.toLocaleString()} products</span>
                {parsedPayload.pagination && (
                  <span>Next page {parsedPayload.pagination.has_next_page ? "available" : "none"}</span>
                )}
              </div>

              {parsedProducts.length > 0 && (
                <div className="product-grid">
                  {parsedProducts.map((product, productIndex) => {
                    const imageUrl = firstProductImage(product);
                    const variants = product.variants || [];
                    const availableCount = variants.filter((variant) => variant.availability?.available).length;
                    const description = stripHtml(product.description?.html);
                    return (
                      <article className="product-card" key={product.id || product.handle || `${product.title}-${productIndex}`}>
                        {imageUrl ? (
                          <img src={imageUrl} alt={product.title || "Shopify product"} />
                        ) : (
                          <div className="product-image-placeholder">No image</div>
                        )}
                        <div className="product-card-body">
                          <div>
                            <h3>{product.title || "Untitled product"}</h3>
                            {description && <p>{description.slice(0, 220)}</p>}
                          </div>
                          <div className="product-meta">
                            <span>{priceRangeLabel(product)}</span>
                            <span>
                              {availableCount.toLocaleString()} of {variants.length.toLocaleString()} available
                            </span>
                          </div>
                          {variants.length > 0 && (
                            <div className="variant-list">
                              {variants.slice(0, 5).map((variant, variantIndex) => (
                                <div className="variant-row" key={variant.id || `${variant.title}-${variantIndex}`}>
                                  <span>{variant.title || "Variant"}</span>
                                  <small>{formatMoney(variant.price) || (variant.sku ? `SKU ${variant.sku}` : "")}</small>
                                </div>
                              ))}
                              {variants.length > 5 && <div className="variant-more">+{variants.length - 5} more variants</div>}
                            </div>
                          )}
                          {product.url && (
                            <a className="product-link" href={product.url} target="_blank" rel="noreferrer">
                              Open product
                            </a>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <pre className="json-response">{prettyJson(result)}</pre>
        </div>
      )}
    </section>
  );
}

export function App() {
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname));
  const [config, setConfig] = useState<StyleConfig | null>(null);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [engineParams, setEngineParams] = useState("{}");
  const [size, setSize] = useState("1K");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [modelFiles, setModelFiles] = useState<FileWithRelativePath[]>([]);
  const [productFiles, setProductFiles] = useState<FileWithRelativePath[]>([]);
  const [folderFiles, setFolderFiles] = useState<FileWithRelativePath[]>([]);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    const onPopState = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((data: StyleConfig) => {
        setConfig(data);
        const nextSettings: Record<string, string> = {};
        Object.entries(data.photoshootConfig).forEach(([key, category]) => {
          nextSettings[key] = Object.keys(category.options)[0];
        });
        setSettings(nextSettings);
      })
      .catch(() => setError("Could not load style_config.json from the API."));
  }, []);

  const referenceNames = useMemo(
    () => [...modelFiles, ...productFiles, ...folderFiles].map((file) => stemName(file)),
    [modelFiles, productFiles, folderFiles]
  );

  const imageSrc = result ? `data:${result.mime_type};base64,${result.image_base64}` : "";

  function navigate(nextPage: Page) {
    window.history.pushState(null, "", pathForPage(nextPage));
    setPage(nextPage);
  }

  function onFiles(setter: (files: FileWithRelativePath[]) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setter(Array.from(event.target.files || []) as FileWithRelativePath[]);
    };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!prompt.trim()) {
      setError("Add a prompt before generating.");
      return;
    }

    try {
      JSON.parse(engineParams || "{}");
    } catch {
      setError("Engine params must be valid JSON.");
      return;
    }

    setIsGenerating(true);
    try {
      const [preparedModelFiles, preparedProductFiles, preparedFolderFiles] = await Promise.all([
        Promise.all(modelFiles.map((file) => prepareImageForUpload(file))),
        Promise.all(productFiles.map((file) => prepareImageForUpload(file))),
        Promise.all(folderFiles.map((file) => prepareImageForUpload(file)))
      ]);
      const uploadBytes = totalBytes([...preparedModelFiles, ...preparedProductFiles, ...preparedFolderFiles]);
      if (uploadBytes > MAX_UPLOAD_BYTES) {
        throw new Error(
          `Reference uploads are ${(uploadBytes / 1024 / 1024).toFixed(1)} MB after compression. ` +
            "Vercel functions accept about 4.5 MB per request, so use fewer references or smaller images."
        );
      }

      const form = new FormData();
      form.append("initial_prompt", prompt);
      form.append("size", size);
      form.append("aspect_ratio", aspectRatio);
      form.append("engine_params", engineParams || "{}");
      Object.entries(settings).forEach(([key, value]) => form.append(key, value));
      preparedModelFiles.forEach((file) => form.append("model_images", file, file.name));
      preparedProductFiles.forEach((file) => form.append("product_images", file, file.name));
      preparedFolderFiles.forEach((file) => form.append("reference_images", file, file.name));

      const response = await fetch("/api/generate", {
        method: "POST",
        body: form
      });
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : { detail: await response.text() };
      if (!response.ok) {
        throw new Error(data.detail || "Generation failed.");
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>VisualOS</h1>
          <p>{page === "shopify" ? "Shopify Storefront MCP tester" : "LangGraph Gemini photoshoot agent"}</p>
        </div>
        <div className="topbar-actions">
          <nav className="nav-tabs" aria-label="App pages">
            <button className={page === "create" ? "nav-tab active" : "nav-tab"} type="button" onClick={() => navigate("create")}>
              Create
            </button>
            <button className={page === "shopify" ? "nav-tab active" : "nav-tab"} type="button" onClick={() => navigate("shopify")}>
              Shopify MCP
            </button>
          </nav>
          <div className="status-pill">Session only</div>
        </div>
      </section>

      {page === "shopify" ? (
        <ShopifyMcpPage />
      ) : (
        <form className="workspace" onSubmit={submit}>
          <section className="left-pane">
            <div className="surface">
              <div className="section-heading">
                <div className="heading-with-icon">
                  <Sparkles size={18} />
                  <h2>Prompt</h2>
                </div>
              </div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={10}
                placeholder="Reference (model), (product1), and (product2) by filename stem."
              />
              {referenceNames.length > 0 && (
                <div className="reference-tags">
                  {referenceNames.map((name) => (
                    <span key={name}>({name})</span>
                  ))}
                </div>
              )}
            </div>

            <div className="surface">
              <div className="section-heading">
                <div className="heading-with-icon">
                  <FolderOpen size={18} />
                  <h2>References</h2>
                </div>
              </div>
              <div className="upload-grid">
                <label className="upload-box">
                  <ImagePlus size={20} />
                  <span>Model images</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onFiles(setModelFiles)} />
                </label>
                <label className="upload-box">
                  <Upload size={20} />
                  <span>Product images</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={onFiles(setProductFiles)} />
                </label>
                <label className="upload-box">
                  <FolderOpen size={20} />
                  <span>Reference folder</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={onFiles(setFolderFiles)}
                    {...folderUploadProps}
                  />
                </label>
              </div>
              <FileList title="Model" files={modelFiles} />
              <FileList title="Product" files={productFiles} />
              <FileList title="Folder" files={folderFiles} />
            </div>
          </section>

          <section className="right-pane">
            <div className="surface">
              <div className="section-heading">
                <h2>Image Settings</h2>
              </div>
              <div className="settings-grid">
                {config &&
                  Object.entries(config.photoshootConfig).map(([key, category]) => (
                    <SelectField
                      key={key}
                      id={key}
                      category={category}
                      value={settings[key] || ""}
                      onChange={(value) => setSettings((current) => ({ ...current, [key]: value }))}
                    />
                  ))}
                <label className="field">
                  <span>Size</span>
                  <select value={size} onChange={(event) => setSize(event.target.value)}>
                    <option value="1K">1K</option>
                    <option value="2K">2K</option>
                    <option value="4K">4K</option>
                  </select>
                </label>
                <label className="field">
                  <span>Aspect Ratio</span>
                  <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                    {ASPECT_RATIOS.map((ratio) => (
                      <option key={ratio} value={ratio}>
                        {ratio}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="field engine-field">
                <span>Engine Params JSON</span>
                <textarea value={engineParams} onChange={(event) => setEngineParams(event.target.value)} rows={4} />
              </label>
            </div>

            <button className="generate-button" disabled={isGenerating || !config} type="submit">
              {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
              {isGenerating ? "Generating" : "Generate preview"}
            </button>

            {error && <div className="error-box">{error}</div>}

            {result && (
              <div className="surface result-surface">
                <div className="result-toolbar">
                  <h2>Preview</h2>
                  <a className="download-link" download="visualos-generation.png" href={imageSrc}>
                    <Download size={16} />
                    Download
                  </a>
                </div>
                <img className="preview-image" src={imageSrc} alt="Generated VisualOS preview" />
                <details>
                  <summary>Refined prompt</summary>
                  <p>{result.refined_prompt}</p>
                </details>
                <details>
                  <summary>Reference mapping</summary>
                  <pre>{result.reference_mapping}</pre>
                </details>
              </div>
            )}
          </section>
        </form>
      )}
    </main>
  );
}
