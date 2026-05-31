# VisualOS Shopify Admin Assistant

AI-powered Shopify admin assistant for multi-shop bulk product creation. Users
log in with a 4-digit PIN, choose or create a Shopify shop, build a fresh batch
of product cards, optionally generate product images and catalog copy, approve
each product, then publish the approved products to Shopify.

The previous VisualOS app has been archived under `legacy_visualos/`.

## Workflow

1. Log in with the VisualOS admin PIN.
2. Create or select a saved Shopify shop.
3. Add one product card per Shopify product.
4. Upload one or more product images, choose exactly one uploaded image as the
   generation reference, and order the media exactly as it should appear on
   Shopify.
5. Enter SKU, sizes, quantity per size, per-product location, optional price,
   optional compare-at price, comma-separated tags, and comma-separated
   collection names.
6. Optionally generate a product image in `Photoshoot` or `Flat lay` mode, with
   per-product aspect ratio and `1K`, `2K`, or `4K` resolution controls.
7. Optionally generate title and description using global prompt defaults plus
   per-product notes.
8. Edit product details, approve cards, then publish approved products.

## Security And Shops

Set these values in `.env` or `backend/.env`:

```bash
VISUALOS_ADMIN_PIN=1234
VISUALOS_SESSION_SECRET=change-this-to-a-long-random-string
GEMINI_API_KEY=...
```

Shop credentials are stored server-side in `data/shops.json`, which is ignored
by git. The browser only sends a `shop_id` when publishing; Client ID, Client
Secret, optional legacy Admin token, and Publication ID are loaded by the
backend. Inventory location is entered per product, not on the shop.

On Vercel, serverless functions cannot persist project-directory files. The app
defaults shop storage to `/tmp/visualos/shops.json` when `VERCEL` is present,
which avoids write errors but is not durable across cold starts. For production
you can set `VISUALOS_SHOPS_JSON` as a seeded JSON list, or move shop storage to
durable storage such as Vercel KV/Postgres.

Each shop can use Shopify Client Credentials auth:

```text
Client ID
Client Secret
```

Legacy Admin tokens are still supported as a fallback.

## Shopify Scopes

Recommended scopes:

```text
write_products
read_products
write_files
write_inventory
read_inventory
write_publications
read_locations
```

`read_locations` is only needed when you enter a product location name instead of
a raw `gid://shopify/Location/...`. If no location is available, products and
variants are still created, but inventory updates are skipped.

## API

Public:

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`

Protected:

- `GET /api/config`
- `GET /api/shops`
- `POST /api/shops`
- `PUT /api/shops/{shop_id}`
- `DELETE /api/shops/{shop_id}`
- `GET /api/shops/{shop_id}/collections`
- `POST /api/shops/{shop_id}/collections`
- `POST /api/products/generate-image`
- `POST /api/products/generate-metadata`
- `POST /api/products/publish-batch`

Publishing uses `stagedUploadsCreate` for every ordered local media item, then
creates the product with `productCreate`, `tags`, and `collectionsToJoin`.
Variants are created with `productVariantsBulkCreate`, including optional
`compareAtPrice` for sale pricing, and stock is applied with `inventoryActivate`
and `inventorySetQuantities` when a location is available.

In the frontend, collection entry is CSV-style. Each collection name or handle is
matched against the shop's loaded collections before publish. If a collection is
missing, the product card shows `Collection "x" is missing` and publishing is
blocked until the collection is created or removed from the CSV field.

## Local Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Start the Python API from the project root:

```bash
uvicorn backend.api:app --reload --port 8000
```

Start the frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173/frontend/`.

## Deployment

The project includes `vercel.json` with:

- Python FastAPI serverless entrypoint: `api/index.py`
- Vite static frontend: `frontend/`

Set `VISUALOS_ADMIN_PIN`, `VISUALOS_SESSION_SECRET`, `GEMINI_API_KEY`, and any
deployment-specific storage/secrets before deploying. For Vercel, also set:

```bash
VISUALOS_DATA_DIR=/tmp/visualos
```
