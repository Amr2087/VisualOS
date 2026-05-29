# VisualOS

LangGraph-powered Gemini photoshoot agent. The user enters a prompt, chooses image
settings from `backend/style_config.json`, uploads optional named reference images,
and receives a preview image that can be downloaded.

## Local Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Add your Gemini key:

```bash
cp .env.example .env
# GEMINI_API_KEY=...
```

If `.env.example` is not present, create `.env` with:

```bash
GEMINI_API_KEY=your_api_key_here
```

## Run Locally

Start the Python API:

```bash
uvicorn backend.api:app --reload --port 8000
```

Start the TypeScript frontend:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

## Reference Naming

Reference images are mapped by filename stem. For example:

```text
ref/
  model.png
  product1.png
  product2.png
```

Use those names in the prompt:

```text
Use (model) as the person reference, (product1) as the top, and
(product2) as the shoes.
```

The frontend sends folder uploads and individual uploads to the backend. The
LangGraph agent prepends a reference mapping before refining the prompt, then
passes the same images to Gemini in that order.

## Deployment

The project includes `vercel.json` with:

- Python FastAPI serverless entrypoint: `api/index.py`
- Vite static frontend: `frontend/`

Set `GEMINI_API_KEY` in Vercel project environment variables before deploying.

## Shopify Product Push

The Shopify MCP tester can draft products locally. To push those drafts into
Shopify Admin, create a custom app in the target store and add an Admin API
access token with these scopes:

```text
write_products
read_locations
write_inventory
write_publications
```

For new Shopify Dev Dashboard apps, set the client credentials in `.env` or in
Vercel:

```bash
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_ADMIN_API_VERSION=2026-04
```

The backend exchanges those credentials for a short-lived Shopify access token
with the client-credentials grant and refreshes from its in-memory cache when
needed.

Legacy custom apps with a static `shpat_` token can still use:

```bash
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
SHOPIFY_ADMIN_API_VERSION=2026-04
```

You can also paste the Client ID/Secret or legacy Admin API token directly into
the Shopify page in the app. Credentials entered in the UI are kept in browser
session storage and sent only with product push requests.

The push flow follows an MCP-style Shopify Admin pipeline:

1. Create the base product with `productCreate`.
2. Create size variants with `productVariantsBulkCreate`.
3. Set per-size quantity with `inventorySetQuantities`.
4. Optionally publish with `publishablePublish`.

Optional:

```bash
# Use a specific inventory location instead of the first active location.
SHOPIFY_ADMIN_LOCATION_ID=gid://shopify/Location/...

# Publish to a specific sales channel/publication after creation.
SHOPIFY_ADMIN_PUBLICATION_ID=gid://shopify/Publication/...
```

If no Location ID or branch is provided, VisualOS skips inventory quantity
updates and does not request the `locations` field. If you enter a branch name,
Shopify requires the `read_locations` scope so VisualOS can resolve that name to
a Location ID.

For multiple stores, use a shop-specific token key. For
`k1b1zg-kc.myshopify.com`, set:

```bash
SHOPIFY_CLIENT_ID_K1B1ZG_KC=...
SHOPIFY_CLIENT_SECRET_K1B1ZG_KC=...
SHOPIFY_ADMIN_ACCESS_TOKEN_K1B1ZG_KC=shpat_...
```
