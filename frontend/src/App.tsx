import { ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  ImagePlus,
  Layers3,
  Loader2,
  LockKeyhole,
  LogOut,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Store,
  Tags,
  Trash2,
  UploadCloud
} from "lucide-react";

type ImageMode = "photoshoot" | "flat_lay";
type ProductStatus = "draft" | "generated" | "approved" | "published" | "error";
type MediaKind = "uploaded" | "generated";

type Shop = {
  id: string;
  name: string;
  shop_domain: string;
  admin_api_version: string;
  location_id: string;
  publication_id: string;
  has_client_id: boolean;
  has_client_secret: boolean;
  has_legacy_token: boolean;
};

type ShopForm = {
  name: string;
  shop_domain: string;
  shopify_client_id: string;
  shopify_client_secret: string;
  admin_access_token: string;
  admin_api_version: string;
  location_id: string;
  publication_id: string;
};

type ShopifyCollection = {
  id: string;
  title: string;
  handle: string;
};

type ProductSizeInventory = {
  id: string;
  size: string;
  quantity: string;
};

type ProductMedia = {
  id: string;
  kind: MediaKind;
  filename: string;
  mimeType: string;
  previewUrl: string;
  imageBase64?: string;
  file?: File;
  enabled: boolean;
};

type ProductCard = {
  id: string;
  sku: string;
  title: string;
  description: string;
  price: string;
  branch: string;
  imageMode: ImageMode;
  generationEnabled: boolean;
  autoMetadata: boolean;
  imageNotes: string;
  titleNotes: string;
  descriptionNotes: string;
  tags: string;
  collectionIds: string[];
  sizes: ProductSizeInventory[];
  media: ProductMedia[];
  refinedPrompt: string;
  status: ProductStatus;
  error: string;
  publishResult?: BatchPublishItemResult;
};

type PromptDefaults = {
  image: string;
  title: string;
  description: string;
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

type PublishMediaPayload = {
  id: string;
  kind: MediaKind;
  filename: string;
  mime_type: string;
  image_base64: string;
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
  media_count?: number;
  media_status?: string;
  inventory_status?: string;
  tags?: string[];
  collection_ids?: string[];
};

type BatchPublishResult = {
  shop_domain: string;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchPublishItemResult[];
};

const MAX_REFERENCE_SIDE = 1280;
const REFERENCE_JPEG_QUALITY = 0.84;

const DEFAULT_PROMPTS: PromptDefaults = {
  image:
    "Preserve the uploaded product exactly, keep colors and silhouette faithful, and create a premium Shopify-ready product visual.",
  title: "Create a concise SEO-friendly Shopify product title based only on visible details.",
  description: "Write polished Shopify product-page copy that describes visible product details without inventing claims."
};

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
    imageMode: "photoshoot",
    generationEnabled: true,
    autoMetadata,
    imageNotes: "",
    titleNotes: "",
    descriptionNotes: "",
    tags: "",
    collectionIds: [],
    sizes: [createSizeInventory()],
    media: [],
    refinedPrompt: "",
    status: "draft",
    error: ""
  };
}

function createShopForm(shop?: Shop): ShopForm {
  return {
    name: shop?.name || "",
    shop_domain: shop?.shop_domain || "",
    shopify_client_id: "",
    shopify_client_secret: "",
    admin_access_token: "",
    admin_api_version: shop?.admin_api_version || "2026-04",
    location_id: shop?.location_id || "",
    publication_id: shop?.publication_id || ""
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

function errorMessage(data: unknown) {
  if (data && typeof data === "object" && "detail" in data) {
    const detail = (data as { detail: unknown }).detail;
    return typeof detail === "string" ? detail : prettyJson(detail);
  }
  return typeof data === "string" ? data : prettyJson(data);
}

async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "include" });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : { detail: await response.text() };
  if (!response.ok) {
    throw new Error(errorMessage(data));
  }
  return data;
}

function getJson<T>(url: string) {
  return apiRequest<T>(url);
}

function postJson<T>(url: string, body: unknown) {
  return apiRequest<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function putJson<T>(url: string, body: unknown) {
  return apiRequest<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function deleteJson<T>(url: string) {
  return apiRequest<T>(url, { method: "DELETE" });
}

async function postForm<T>(url: string, formData: FormData): Promise<T> {
  return apiRequest<T>(url, { method: "POST", body: formData });
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",", 2)[1] : value);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function generatedDataUrl(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
}

function createUploadedMedia(file: File): ProductMedia {
  return {
    id: makeId(),
    kind: "uploaded",
    filename: file.name,
    mimeType: file.type || "image/jpeg",
    previewUrl: URL.createObjectURL(file),
    file,
    enabled: true
  };
}

function enabledMedia(product: ProductCard) {
  return product.media.filter((item) => item.enabled);
}

function firstEnabledMedia(product: ProductCard) {
  return enabledMedia(product)[0] || null;
}

function uploadedMedia(product: ProductCard) {
  return product.media.filter((item) => item.kind === "uploaded" && item.file && item.enabled);
}

function parseTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function mergePrompt(defaultPrompt: string, notes: string) {
  return [defaultPrompt.trim(), notes.trim()].filter(Boolean).join("\n\n");
}

async function mediaToPayload(media: ProductMedia, sku: string): Promise<PublishMediaPayload> {
  if (media.kind === "generated") {
    if (!media.imageBase64) throw new Error("Generated media is missing image data.");
    return {
      id: media.id,
      kind: media.kind,
      filename: media.filename || `${sku || "product"}-generated.png`,
      mime_type: media.mimeType || "image/png",
      image_base64: media.imageBase64
    };
  }
  if (!media.file) throw new Error(`${media.filename} is missing its uploaded file.`);
  const preparedFile = await prepareImageForUpload(media.file);
  return {
    id: media.id,
    kind: media.kind,
    filename: preparedFile.name,
    mime_type: preparedFile.type || "image/jpeg",
    image_base64: await fileToBase64(preparedFile)
  };
}

export function App() {
  const [sessionState, setSessionState] = useState<"loading" | "anonymous" | "authenticated">("loading");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [shops, setShops] = useState<Shop[]>([]);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [shopForm, setShopForm] = useState<ShopForm>(() => createShopForm());
  const [editingShopId, setEditingShopId] = useState<string | null>(null);
  const [shopError, setShopError] = useState("");
  const [collections, setCollections] = useState<ShopifyCollection[]>([]);
  const [collectionsError, setCollectionsError] = useState("");
  const [newCollectionTitle, setNewCollectionTitle] = useState("");
  const [products, setProducts] = useState<ProductCard[]>(() => [createProductCard()]);
  const [batchAutoMetadata, setBatchAutoMetadata] = useState(true);
  const [promptDefaults, setPromptDefaults] = useState<PromptDefaults>(DEFAULT_PROMPTS);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [lastPublishResult, setLastPublishResult] = useState<BatchPublishResult | null>(null);

  const generatedCount = products.filter((product) => product.media.some((media) => media.kind === "generated")).length;
  const approvedCount = products.filter((product) => product.status === "approved").length;
  const readyToPublish = useMemo(
    () => products.filter((product) => product.status === "approved" && enabledMedia(product).length),
    [products]
  );

  useEffect(() => {
    checkSession();
  }, []);

  async function checkSession() {
    try {
      const session = await getJson<{ authenticated: boolean }>("/api/auth/session");
      setSessionState(session.authenticated ? "authenticated" : "anonymous");
      if (session.authenticated) {
        await loadShops();
      }
    } catch {
      setSessionState("anonymous");
    }
  }

  async function login() {
    setLoginError("");
    try {
      await postJson<{ authenticated: boolean }>("/api/auth/login", { pin });
      setSessionState("authenticated");
      setPin("");
      await loadShops();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Login failed.");
    }
  }

  async function logout() {
    await postJson<{ authenticated: boolean }>("/api/auth/logout", {});
    setSessionState("anonymous");
    setSelectedShop(null);
    setShops([]);
    setProducts([createProductCard(batchAutoMetadata)]);
  }

  async function loadShops() {
    const data = await getJson<{ shops: Shop[] }>("/api/shops");
    setShops(data.shops);
  }

  async function saveShop() {
    setShopError("");
    const payload = {
      ...shopForm,
      shop_domain: normalizeShopDomain(shopForm.shop_domain)
    };
    try {
      if (editingShopId) {
        await putJson<{ shop: Shop }>(`/api/shops/${editingShopId}`, payload);
      } else {
        await postJson<{ shop: Shop }>("/api/shops", payload);
      }
      setShopForm(createShopForm());
      setEditingShopId(null);
      await loadShops();
    } catch (error) {
      setShopError(error instanceof Error ? error.message : "Could not save shop.");
    }
  }

  async function deleteShop(shopId: string) {
    setShopError("");
    try {
      await deleteJson<{ deleted: boolean }>(`/api/shops/${shopId}`);
      if (selectedShop?.id === shopId) setSelectedShop(null);
      await loadShops();
    } catch (error) {
      setShopError(error instanceof Error ? error.message : "Could not delete shop.");
    }
  }

  function startEditShop(shop: Shop) {
    setEditingShopId(shop.id);
    setShopForm(createShopForm(shop));
    setShopError("");
  }

  async function selectShop(shop: Shop) {
    setSelectedShop(shop);
    setProducts([createProductCard(batchAutoMetadata)]);
    setLastPublishResult(null);
    setGlobalError("");
    await loadCollections(shop);
  }

  async function loadCollections(shop: Shop) {
    setCollections([]);
    setCollectionsError("");
    try {
      const data = await getJson<{ collections: ShopifyCollection[] }>(`/api/shops/${shop.id}/collections`);
      setCollections(data.collections);
    } catch (error) {
      setCollectionsError(error instanceof Error ? error.message : "Could not load collections.");
    }
  }

  function switchShop() {
    setSelectedShop(null);
    setProducts([createProductCard(batchAutoMetadata)]);
    setCollections([]);
    setLastPublishResult(null);
  }

  async function createCollection() {
    if (!selectedShop || !newCollectionTitle.trim()) return;
    setCollectionsError("");
    try {
      const data = await postJson<{ collection: ShopifyCollection }>(`/api/shops/${selectedShop.id}/collections`, {
        title: newCollectionTitle.trim()
      });
      setCollections((current) => [...current, data.collection].sort((a, b) => a.title.localeCompare(b.title)));
      setNewCollectionTitle("");
    } catch (error) {
      setCollectionsError(error instanceof Error ? error.message : "Could not create collection.");
    }
  }

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

  function addFiles(productId: string, files: FileList | null) {
    const media = Array.from(files || []).map(createUploadedMedia);
    if (!media.length) return;
    setProducts((current) =>
      current.map((product) =>
        product.id === productId ? { ...product, media: [...product.media, ...media], error: "", status: "draft" } : product
      )
    );
  }

  function patchMedia(productId: string, mediaId: string, patch: Partial<ProductMedia>) {
    setProducts((current) =>
      current.map((product) =>
        product.id === productId
          ? { ...product, media: product.media.map((media) => (media.id === mediaId ? { ...media, ...patch } : media)) }
          : product
      )
    );
  }

  function removeMedia(productId: string, mediaId: string) {
    setProducts((current) =>
      current.map((product) =>
        product.id === productId ? { ...product, media: product.media.filter((media) => media.id !== mediaId) } : product
      )
    );
  }

  function moveMedia(productId: string, mediaId: string, direction: -1 | 1) {
    setProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;
        const media = [...product.media];
        const index = media.findIndex((item) => item.id === mediaId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= media.length) return product;
        [media[index], media[nextIndex]] = [media[nextIndex], media[index]];
        return { ...product, media };
      })
    );
  }

  function toggleCollection(productId: string, collectionId: string) {
    setProducts((current) =>
      current.map((product) => {
        if (product.id !== productId) return product;
        const collectionIds = product.collectionIds.includes(collectionId)
          ? product.collectionIds.filter((id) => id !== collectionId)
          : [...product.collectionIds, collectionId];
        return { ...product, collectionIds };
      })
    );
  }

  function productValidation(product: ProductCard) {
    if (!product.sku.trim()) return "SKU is required.";
    if (!enabledMedia(product).length) return "Add at least one enabled media image.";
    if (!product.title.trim()) return "Title is required before approval.";
    if (product.price.trim() && Number.isNaN(Number(product.price))) return "Price must be numeric.";
    if (product.sizes.some((row) => row.quantity.trim() && Number.isNaN(Number(row.quantity)))) return "Quantities must be numeric.";
    return "";
  }

  async function generateMetadata(product: ProductCard, sourceMedia?: ProductMedia) {
    const media = sourceMedia || firstEnabledMedia(product);
    if (!media) {
      patchProduct(product.id, { error: "Add or generate an image before metadata generation.", status: "error" });
      return;
    }
    setActiveProductId(product.id);
    setActiveAction("metadata");
    try {
      const payload = await mediaToPayload(media, product.sku);
      const metadata = await postJson<MetadataResult>("/api/products/generate-metadata", {
        image_base64: payload.image_base64,
        mime_type: payload.mime_type,
        sku: product.sku,
        hints: product.imageNotes,
        title_prompt: mergePrompt(promptDefaults.title, product.titleNotes),
        description_prompt: mergePrompt(promptDefaults.description, product.descriptionNotes)
      });
      patchProduct(product.id, {
        title: metadata.title || product.title,
        description: metadata.description || product.description,
        error: ""
      });
    } catch (error) {
      patchProduct(product.id, {
        status: "error",
        error: error instanceof Error ? error.message : "Metadata generation failed."
      });
    } finally {
      setActiveProductId(null);
      setActiveAction("");
    }
  }

  async function generateProduct(product: ProductCard) {
    if (!product.generationEnabled) {
      patchProduct(product.id, { status: "generated", error: "" });
      if (product.autoMetadata) await generateMetadata(product);
      return;
    }
    const references = uploadedMedia(product);
    if (!references.length) {
      patchProduct(product.id, { error: "Upload at least one enabled product image before generation.", status: "error" });
      return;
    }
    if (!product.sku.trim()) {
      patchProduct(product.id, { error: "SKU is required before generation.", status: "error" });
      return;
    }

    setActiveProductId(product.id);
    setActiveAction("image");
    patchProduct(product.id, { error: "", status: "draft" });
    try {
      const formData = new FormData();
      formData.set("sku", product.sku);
      formData.set("image_mode", product.imageMode);
      formData.set("user_hints", product.imageNotes);
      formData.set("prompt_template", promptDefaults.image);
      formData.set("size", "1K");
      formData.set("aspect_ratio", "1:1");
      for (const media of references) {
        if (media.file) formData.append("product_images", await prepareImageForUpload(media.file));
      }
      const imageResult = await postForm<GenerateImageResult>("/api/products/generate-image", formData);
      const generatedMedia: ProductMedia = {
        id: makeId(),
        kind: "generated",
        filename: `${product.sku || "product"}-generated.png`,
        mimeType: imageResult.mime_type,
        previewUrl: generatedDataUrl(imageResult.mime_type, imageResult.image_base64),
        imageBase64: imageResult.image_base64,
        enabled: true
      };

      setProducts((current) =>
        current.map((item) => {
          if (item.id !== product.id) return item;
          const existingGeneratedIndex = item.media.findIndex((media) => media.kind === "generated");
          const nextMedia = [...item.media];
          if (existingGeneratedIndex >= 0) nextMedia[existingGeneratedIndex] = generatedMedia;
          else nextMedia.unshift(generatedMedia);
          return {
            ...item,
            media: nextMedia,
            refinedPrompt: imageResult.refined_prompt,
            status: "generated",
            error: ""
          };
        })
      );

      if (product.autoMetadata) {
        await generateMetadata({ ...product, media: [generatedMedia, ...product.media] }, generatedMedia);
      }
    } catch (error) {
      patchProduct(product.id, {
        status: "error",
        error: error instanceof Error ? error.message : "Generation failed."
      });
    } finally {
      setActiveProductId(null);
      setActiveAction("");
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
    if (validation) {
      patchProduct(id, { status: "error", error: validation });
      return;
    }
    patchProduct(id, { status: "approved", error: "" });
  }

  function approveAll() {
    products.forEach((product) => approveProduct(product.id));
  }

  async function publishPayload() {
    const payload = [];
    for (const product of readyToPublish) {
      payload.push({
        id: product.id,
        title: product.title.trim(),
        description: product.description.trim(),
        sku: product.sku.trim(),
        branch: product.branch.trim() || null,
        price: product.price.trim() ? Number(product.price) : null,
        sizes: product.sizes
          .filter((row) => row.size.trim())
          .map((row) => ({ size: row.size.trim(), qty: Number(row.quantity || 0) })),
        media_items: await Promise.all(enabledMedia(product).map((media) => mediaToPayload(media, product.sku))),
        tags: parseTags(product.tags),
        collection_ids: product.collectionIds
      });
    }
    return payload;
  }

  async function publishApproved() {
    if (!selectedShop) {
      setGlobalError("Choose a shop first.");
      return;
    }
    if (!readyToPublish.length) {
      setGlobalError("Approve at least one product first.");
      return;
    }

    setIsPublishing(true);
    setGlobalError("");
    setLastPublishResult(null);
    try {
      const result = await postJson<BatchPublishResult>("/api/products/publish-batch", {
        shop_id: selectedShop.id,
        products: await publishPayload()
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
    await navigator.clipboard.writeText(prettyJson(await publishPayload()));
  }

  if (sessionState === "loading") {
    return (
      <main className="center-shell">
        <section className="login-card">
          <Loader2 className="spin" size={22} />
          <h1>Loading VisualOS</h1>
        </section>
      </main>
    );
  }

  if (sessionState === "anonymous") {
    return (
      <main className="center-shell">
        <section className="login-card">
          <LockKeyhole size={26} />
          <div>
            <p className="eyebrow">VisualOS Shopify Assistant</p>
            <h1>Enter admin PIN</h1>
          </div>
          <input
            inputMode="numeric"
            maxLength={4}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && pin.length === 4) void login();
            }}
            placeholder="4 digit PIN"
            type="password"
          />
          <button className="primary-button" type="button" onClick={login} disabled={pin.length !== 4}>
            Unlock
          </button>
          {loginError && <div className="error-box">{loginError}</div>}
        </section>
      </main>
    );
  }

  if (!selectedShop) {
    return (
      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">VisualOS Shopify Assistant</p>
            <h1>Shop manager</h1>
          </div>
          <button className="secondary-button" type="button" onClick={logout}>
            <LogOut size={16} />
            Logout
          </button>
        </header>

        <section className="admin-grid">
          <section className="surface">
            <div className="section-heading">
              <Store size={18} />
              <h2>Shops</h2>
            </div>
            <div className="shop-list">
              {shops.map((shop) => (
                <article className="shop-row" key={shop.id}>
                  <div>
                    <strong>{shop.name}</strong>
                    <span>{shop.shop_domain}</span>
                    <small>
                      {shop.has_client_secret ? "Client credentials saved" : shop.has_legacy_token ? "Legacy token saved" : "Missing credentials"}
                    </small>
                  </div>
                  <div className="row-actions">
                    <button className="secondary-button" type="button" onClick={() => selectShop(shop)}>
                      Open
                    </button>
                    <button className="icon-button" type="button" onClick={() => startEditShop(shop)} title="Edit shop">
                      <Pencil size={15} />
                    </button>
                    <button className="icon-button danger" type="button" onClick={() => deleteShop(shop.id)} title="Delete shop">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              ))}
              {!shops.length && <div className="empty-note">Create your first shop to start a fresh product batch.</div>}
            </div>
          </section>

          <section className="surface">
            <div className="section-heading">
              <Settings2 size={18} />
              <h2>{editingShopId ? "Edit shop" : "Create shop"}</h2>
            </div>
            <label className="field">
              <span>Display name</span>
              <input value={shopForm.name} onChange={(event) => setShopForm({ ...shopForm, name: event.target.value })} />
            </label>
            <label className="field">
              <span>Shop domain</span>
              <input
                value={shopForm.shop_domain}
                onChange={(event) => setShopForm({ ...shopForm, shop_domain: event.target.value })}
                placeholder="store.myshopify.com"
              />
            </label>
            <div className="two-col">
              <label className="field">
                <span>Client ID</span>
                <input
                  value={shopForm.shopify_client_id}
                  onChange={(event) => setShopForm({ ...shopForm, shopify_client_id: event.target.value })}
                  placeholder={editingShopId ? "Leave blank to keep saved" : ""}
                />
              </label>
              <label className="field">
                <span>Client secret</span>
                <input
                  type="password"
                  value={shopForm.shopify_client_secret}
                  onChange={(event) => setShopForm({ ...shopForm, shopify_client_secret: event.target.value })}
                  placeholder={editingShopId ? "Leave blank to keep saved" : ""}
                />
              </label>
            </div>
            <label className="field">
              <span>Legacy Admin token</span>
              <input
                type="password"
                value={shopForm.admin_access_token}
                onChange={(event) => setShopForm({ ...shopForm, admin_access_token: event.target.value })}
                placeholder={editingShopId ? "Leave blank to keep saved" : "Optional shpat_..."}
              />
            </label>
            <div className="two-col">
              <label className="field">
                <span>API version</span>
                <input
                  value={shopForm.admin_api_version}
                  onChange={(event) => setShopForm({ ...shopForm, admin_api_version: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Default location</span>
                <input
                  value={shopForm.location_id}
                  onChange={(event) => setShopForm({ ...shopForm, location_id: event.target.value })}
                  placeholder="gid://shopify/Location/..."
                />
              </label>
            </div>
            <label className="field">
              <span>Publication ID</span>
              <input
                value={shopForm.publication_id}
                onChange={(event) => setShopForm({ ...shopForm, publication_id: event.target.value })}
                placeholder="Optional gid://shopify/Publication/..."
              />
            </label>
            <div className="card-actions">
              {editingShopId && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setEditingShopId(null);
                    setShopForm(createShopForm());
                    setShopError("");
                  }}
                >
                  Cancel
                </button>
              )}
              <button className="primary-button" type="button" onClick={saveShop}>
                {editingShopId ? "Save shop" : "Create shop"}
              </button>
            </div>
            {shopError && <div className="error-box">{shopError}</div>}
          </section>
        </section>
      </main>
    );
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">VisualOS Shopify Assistant</p>
          <h1>Bulk product creation</h1>
          <p className="subtle-line">
            {selectedShop.name} - {selectedShop.shop_domain}
          </p>
        </div>
        <div className="topbar-actions">
          <div className="topbar-stats">
            <span>{products.length} products</span>
            <span>{generatedCount} generated</span>
            <span>{approvedCount} approved</span>
          </div>
          <button className="secondary-button" type="button" onClick={switchShop}>
            <Store size={16} />
            Switch shop
          </button>
          <button className="secondary-button" type="button" onClick={logout}>
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <section className="surface">
            <div className="section-heading">
              <Settings2 size={18} />
              <h2>Prompt defaults</h2>
            </div>
            <label className="field">
              <span>Image generation prompt</span>
              <textarea value={promptDefaults.image} onChange={(event) => setPromptDefaults({ ...promptDefaults, image: event.target.value })} />
            </label>
            <label className="field">
              <span>Title prompt</span>
              <textarea value={promptDefaults.title} onChange={(event) => setPromptDefaults({ ...promptDefaults, title: event.target.value })} />
            </label>
            <label className="field">
              <span>Description prompt</span>
              <textarea
                value={promptDefaults.description}
                onChange={(event) => setPromptDefaults({ ...promptDefaults, description: event.target.value })}
              />
            </label>
          </section>

          <section className="surface">
            <div className="section-heading">
              <Layers3 size={18} />
              <h2>Collections</h2>
              <button className="icon-button" type="button" onClick={() => loadCollections(selectedShop)} title="Refresh collections">
                <RefreshCw size={15} />
              </button>
            </div>
            <div className="inline-create">
              <input value={newCollectionTitle} onChange={(event) => setNewCollectionTitle(event.target.value)} placeholder="New collection" />
              <button className="secondary-button" type="button" onClick={createCollection}>
                <Plus size={15} />
              </button>
            </div>
            {collectionsError && <div className="warning-box">{collectionsError}</div>}
            <div className="collection-summary">{collections.length} collection(s) available</div>
          </section>

          <section className="surface">
            <div className="section-heading">
              <PackagePlus size={18} />
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
            {!selectedShop.location_id && (
              <div className="warning-box">Stock is skipped unless this shop has a default Location GID or the product has a branch/location.</div>
            )}
            {lastPublishResult && (
              <div className="result-note">
                Published {lastPublishResult.succeeded} of {lastPublishResult.total}; {lastPublishResult.failed} failed.
              </div>
            )}
          </section>
        </aside>

        <section className="product-grid">
          {products.map((product, index) => {
            const heroMedia = firstEnabledMedia(product);
            return (
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
                  {heroMedia ? (
                    <img src={heroMedia.previewUrl} alt={`${product.sku || "Product"} media`} />
                  ) : (
                    <div className="image-placeholder">
                      <ImagePlus size={28} />
                      <span>Product media</span>
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
                  <span>Upload product images</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      addFiles(product.id, event.target.files);
                      event.target.value = "";
                    }}
                  />
                </label>

                <div className="media-list">
                  {product.media.map((media, mediaIndex) => (
                    <div className="media-row" key={media.id}>
                      <img src={media.previewUrl} alt={media.filename} />
                      <div>
                        <strong>{media.kind === "generated" ? "Generated" : media.filename}</strong>
                        <span>{media.kind} media</span>
                      </div>
                      <label className="tiny-check">
                        <input
                          type="checkbox"
                          checked={media.enabled}
                          onChange={(event) => patchMedia(product.id, media.id, { enabled: event.target.checked })}
                        />
                      </label>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => moveMedia(product.id, media.id, -1)}
                        disabled={mediaIndex === 0}
                        title="Move earlier"
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => moveMedia(product.id, media.id, 1)}
                        disabled={mediaIndex === product.media.length - 1}
                        title="Move later"
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button className="icon-button danger" type="button" onClick={() => removeMedia(product.id, media.id)} title="Remove media">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {!product.media.length && <div className="empty-note">Uploaded and generated images will appear here in Shopify order.</div>}
                </div>

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

                <div className="toggle-grid">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={product.generationEnabled}
                      onChange={(event) => patchProduct(product.id, { generationEnabled: event.target.checked })}
                    />
                    <span>Generate image</span>
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={product.autoMetadata}
                      onChange={(event) => patchProduct(product.id, { autoMetadata: event.target.checked })}
                    />
                    <span>Generate title and description</span>
                  </label>
                </div>

                <label className="field">
                  <span>Image notes</span>
                  <textarea
                    value={product.imageNotes}
                    onChange={(event) => patchProduct(product.id, { imageNotes: event.target.value })}
                    rows={2}
                    placeholder="Colorway, angle, styling, brand-safe notes..."
                  />
                </label>

                <div className="two-col">
                  <label className="field">
                    <span>Title notes</span>
                    <textarea value={product.titleNotes} onChange={(event) => patchProduct(product.id, { titleNotes: event.target.value })} rows={2} />
                  </label>
                  <label className="field">
                    <span>Description notes</span>
                    <textarea
                      value={product.descriptionNotes}
                      onChange={(event) => patchProduct(product.id, { descriptionNotes: event.target.value })}
                      rows={2}
                    />
                  </label>
                </div>

                <label className="field">
                  <span>Tags</span>
                  <input
                    value={product.tags}
                    onChange={(event) => patchProduct(product.id, { tags: event.target.value })}
                    placeholder="comma, separated, tags"
                  />
                </label>

                <div className="collection-picker">
                  <div className="size-editor-heading">
                    <span>Collections</span>
                    <Tags size={14} />
                  </div>
                  {collections.map((collection) => (
                    <label className="check-row" key={collection.id}>
                      <input
                        type="checkbox"
                        checked={product.collectionIds.includes(collection.id)}
                        onChange={() => toggleCollection(product.id, collection.id)}
                      />
                      <span>{collection.title}</span>
                    </label>
                  ))}
                  {!collections.length && <div className="empty-note">No collections loaded for this shop.</div>}
                </div>

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
                      Shopify product created with {product.publishResult.media_count || 0} media item(s). Inventory{" "}
                      {product.publishResult.inventory_status || "unknown"}.
                      {product.publishResult.product?.onlineStorePreviewUrl && (
                        <a href={product.publishResult.product.onlineStorePreviewUrl} target="_blank" rel="noreferrer">
                          Preview
                        </a>
                      )}
                    </span>
                  </div>
                )}

                <div className="card-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => generateProduct(product)}
                    disabled={activeProductId === product.id}
                  >
                    {activeProductId === product.id && activeAction === "image" ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
                    {product.generationEnabled ? "Generate" : "Use uploads"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => generateMetadata(product)}
                    disabled={activeProductId === product.id}
                  >
                    {activeProductId === product.id && activeAction === "metadata" ? <Loader2 className="spin" size={16} /> : <Tags size={16} />}
                    Metadata
                  </button>
                  <button className="primary-button" type="button" onClick={() => approveProduct(product.id)}>
                    <CheckCircle2 size={16} />
                    Approve
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      </section>
    </main>
  );
}

export default App;
