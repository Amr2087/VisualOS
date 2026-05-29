# VisualOS Shopify Admin Assistant

AI-powered Shopify admin assistant for bulk product creation. Users add product
cards, upload product images, generate either a photoshoot or flat-lay product
image, optionally generate title and description copy, approve each card, then
publish approved products to Shopify.

The previous VisualOS app has been archived under `legacy_visualos/`.

## Workflow

1. Add one product card per Shopify product.
2. Upload product images and enter SKU, sizes, quantity per size, optional
   branch/location, and optional price.
3. Choose image style:
   - `Photoshoot` for premium e-commerce campaign imagery.
   - `Flat lay` for clean overhead product-only imagery.
4. Generate the product image.
5. Optionally generate title and description from the generated image.
6. Edit product details and approve the card.
7. Publish all approved products to Shopify.

## API

- `GET /api/health`
- `GET /api/config`
- `POST /api/products/generate-image`
  - Multipart request for one product card.
  - Inputs include product images, SKU, `photoshoot | flat_lay`, and optional
    generation notes.
- `POST /api/products/generate-metadata`
  - JSON request with generated image base64, SKU, and optional hints.
  - Returns strict product title and description fields.
- `POST /api/products/publish-batch`
  - Publishes approved products independently.
  - Uploads generated images to Shopify using `stagedUploadsCreate`.
  - Creates products with `productCreate`.
  - Creates size variants with `productVariantsBulkCreate`.
  - Activates each inventory item at the selected location with
    `inventoryActivate`, then falls back to `inventorySetQuantities` if the
    item was already active. Inventory mutations include Shopify's required
    `@idempotent` directive for API `2026-04`, and quantity setting uses the
    `changeFromQuantity` compare-and-swap field.

Legacy MCP test endpoints are still available for diagnostics:

- `POST /api/shopify-mcp/test`
- `POST /api/shopify-mcp/call`
- `POST /api/shopify-admin/products`

## Local Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create `.env` or `backend/.env`:

```bash
GEMINI_API_KEY=...
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_ADMIN_API_VERSION=2026-04
```

For multiple stores, use shop-specific keys:

```bash
SHOPIFY_CLIENT_ID_K1B1ZG_KC=...
SHOPIFY_CLIENT_SECRET_K1B1ZG_KC=...
```

Legacy static Admin tokens are still supported:

```bash
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
```

Optional Shopify settings:

```bash
SHOPIFY_ADMIN_LOCATION_ID=gid://shopify/Location/...
SHOPIFY_ADMIN_PUBLICATION_ID=gid://shopify/Publication/...
```

Stock requires a Shopify Location GID or an exact location name that can be
resolved to a location. If no location is provided, inventory quantity updates
are skipped and products/variants are still created. If you use a location name,
the app also needs `read_locations`; using a raw `gid://shopify/Location/...`
does not require a location lookup.

## Run Locally

Start the Python API:

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

## Shopify Scopes

Recommended scopes:

```text
write_products
write_files
write_inventory
write_publications
read_locations
```

`read_locations` is only required if you enter a branch name instead of a raw
Shopify Location ID.

## Deployment

The project includes `vercel.json` with:

- Python FastAPI serverless entrypoint: `api/index.py`
- Vite static frontend: `frontend/`

Set `GEMINI_API_KEY` and Shopify credentials in Vercel project environment
variables before deploying.
