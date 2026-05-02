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
