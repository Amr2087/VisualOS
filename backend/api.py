from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
import httpx
from PIL import Image
from pydantic import BaseModel, Field

from .config import load_style_config
from .graph import build_graph
from .state import ReferenceImage

PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(PROJECT_ROOT / "notebooks" / ".env")
load_dotenv(PROJECT_ROOT / "backend" / ".env", override=True)

SUPPORTED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}
SHOPIFY_AGENT_PROFILE = "https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json"
SHOPIFY_UCP_TOOLS = {"search_catalog", "lookup_catalog", "get_product"}
SHOPIFY_STANDARD_TOOLS = {"search_shop_policies_and_faqs", "get_cart", "update_cart"}
SHOPIFY_TOOL_ENDPOINTS = {
    **{tool: "ucp" for tool in SHOPIFY_UCP_TOOLS},
    **{tool: "standard" for tool in SHOPIFY_STANDARD_TOOLS},
}
SHOPIFY_TIMEOUT_SECONDS = 8.0
SHOPIFY_ADMIN_API_VERSION = os.getenv("SHOPIFY_ADMIN_API_VERSION") or os.getenv("SHOPIFY_API_VERSION", "2026-04")
SHOPIFY_ADMIN_PUBLICATION_ID = os.getenv("SHOPIFY_ADMIN_PUBLICATION_ID", "")
SHOPIFY_ADMIN_LOCATION_ID = os.getenv("SHOPIFY_ADMIN_LOCATION_ID", "")
SHOPIFY_CLIENT_ID = os.getenv("SHOPIFY_CLIENT_ID", "")
SHOPIFY_CLIENT_SECRET = os.getenv("SHOPIFY_CLIENT_SECRET", "")
SHOPIFY_TOKEN_REFRESH_MARGIN_SECONDS = 300
SHOPIFY_CLIENT_CREDENTIAL_TOKEN_CACHE: dict[str, dict[str, Any]] = {}
DEFAULT_DATA_DIR = Path("/tmp/visualos") if os.getenv("VERCEL") else PROJECT_ROOT / "data"
DATA_DIR = Path(os.getenv("VISUALOS_DATA_DIR", str(DEFAULT_DATA_DIR)))
SHOPS_FILE = Path(os.getenv("VISUALOS_SHOPS_FILE", str(DATA_DIR / "shops.json")))
SESSION_COOKIE_NAME = "visualos_session"
SESSION_TTL_SECONDS = int(os.getenv("VISUALOS_SESSION_TTL_SECONDS", str(7 * 24 * 60 * 60)))
VISUALOS_ADMIN_PIN = os.getenv("VISUALOS_ADMIN_PIN", "1234")
VISUALOS_SESSION_SECRET = os.getenv("VISUALOS_SESSION_SECRET") or os.getenv("VISUALOS_ADMIN_PIN", "visualos-dev-secret")
COOKIE_SECURE = os.getenv("VISUALOS_COOKIE_SECURE", "").lower() in {"1", "true", "yes"}

app = FastAPI(title="VisualOS API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _session_signature(payload: str) -> str:
    return hmac.new(VISUALOS_SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def _encode_session() -> str:
    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
        "sid": uuid.uuid4().hex,
    }
    payload_text = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8")).decode("utf-8").rstrip("=")
    return f"{payload_text}.{_session_signature(payload_text)}"


def _decode_session(token: str | None) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    payload_text, signature = token.rsplit(".", 1)
    if not hmac.compare_digest(_session_signature(payload_text), signature):
        return None
    try:
        padded_payload = payload_text + "=" * (-len(payload_text) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded_payload.encode("utf-8")))
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload


def require_auth(request: Request) -> dict[str, Any]:
    session = _decode_session(request.cookies.get(SESSION_COOKIE_NAME))
    if not session:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return session


def _shop_public(shop: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": shop.get("id", ""),
        "name": shop.get("name", ""),
        "shop_domain": shop.get("shop_domain", ""),
        "admin_api_version": shop.get("admin_api_version", SHOPIFY_ADMIN_API_VERSION),
        "location_id": shop.get("location_id", ""),
        "publication_id": shop.get("publication_id", ""),
        "has_client_id": bool(shop.get("shopify_client_id")),
        "has_client_secret": bool(shop.get("shopify_client_secret")),
        "has_legacy_token": bool(shop.get("admin_access_token")),
    }


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _read_shops() -> list[dict[str, Any]]:
    if not SHOPS_FILE.exists():
        seeded_shops = os.getenv("VISUALOS_SHOPS_JSON", "").strip()
        if seeded_shops:
            try:
                data = json.loads(seeded_shops)
            except json.JSONDecodeError:
                return []
            return data if isinstance(data, list) else []
        return []
    try:
        data = json.loads(SHOPS_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _write_shops(shops: list[dict[str, Any]]) -> None:
    try:
        _ensure_data_dir()
        SHOPS_FILE.write_text(json.dumps(shops, indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "message": "Could not save shop config on this server.",
                "path": str(SHOPS_FILE),
                "hint": "On Vercel, set VISUALOS_DATA_DIR=/tmp/visualos or use durable storage for shops.",
            },
        ) from exc


def _shop_from_request(request: ShopWriteRequest, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    shop_domain = _normalize_shop_domain(request.shop_domain)
    existing = existing or {}
    return {
        "id": existing.get("id") or uuid.uuid4().hex,
        "name": request.name.strip(),
        "shop_domain": shop_domain,
        "shopify_client_id": request.shopify_client_id.strip() or existing.get("shopify_client_id", ""),
        "shopify_client_secret": request.shopify_client_secret.strip() or existing.get("shopify_client_secret", ""),
        "admin_access_token": request.admin_access_token.strip() or existing.get("admin_access_token", ""),
        "admin_api_version": request.admin_api_version.strip() or existing.get("admin_api_version", SHOPIFY_ADMIN_API_VERSION),
        "location_id": request.location_id.strip() or existing.get("location_id", ""),
        "publication_id": request.publication_id.strip() or existing.get("publication_id", ""),
        "created_at": existing.get("created_at") or int(time.time()),
        "updated_at": int(time.time()),
    }


def _get_shop_private(shop_id: str) -> dict[str, Any]:
    shop = next((item for item in _read_shops() if item.get("id") == shop_id), None)
    if not shop:
        raise HTTPException(status_code=404, detail="Shop not found.")
    return shop


class ShopifyMcpTestRequest(BaseModel):
    shop_domain: str = Field(..., min_length=1)


class ShopifyMcpCallRequest(BaseModel):
    shop_domain: str = Field(..., min_length=1)
    tool: str = Field(..., min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ShopifyProductSizeQuantity(BaseModel):
    size: str = Field(..., min_length=1)
    qty: int = Field(0, ge=0)


class ShopifyProductPublishRequest(BaseModel):
    shop_domain: str = Field(..., min_length=1)
    admin_access_token: str | None = None
    shopify_client_id: str | None = None
    shopify_client_secret: str | None = None
    admin_api_version: str | None = None
    location_id: str | None = None
    publication_id: str | None = None
    img: str = ""
    desc: str = ""
    title: str = Field(..., min_length=1)
    sku: str = Field(..., min_length=1)
    branch: str | None = None
    price: float | None = None
    compare_at_price: float | None = None
    sizes: list[ShopifyProductSizeQuantity] = Field(default_factory=list)
    media_urls: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    collection_ids: list[str] = Field(default_factory=list)


class ProductMetadataRequest(BaseModel):
    image_base64: str = Field(..., min_length=1)
    mime_type: str = "image/png"
    sku: str = ""
    hints: str = ""
    title_prompt: str = ""
    description_prompt: str = ""


class LoginRequest(BaseModel):
    pin: str = Field(..., min_length=4, max_length=4)


class ShopWriteRequest(BaseModel):
    name: str = Field(..., min_length=1)
    shop_domain: str = Field(..., min_length=1)
    shopify_client_id: str = ""
    shopify_client_secret: str = ""
    admin_access_token: str = ""
    admin_api_version: str = ""
    location_id: str = ""
    publication_id: str = ""


class CollectionCreateRequest(BaseModel):
    title: str = Field(..., min_length=1)
    description: str = ""


class PublishMediaItem(BaseModel):
    id: str = Field(..., min_length=1)
    kind: str = "uploaded"
    filename: str = "product-image.jpg"
    mime_type: str = "image/jpeg"
    image_base64: str = Field(..., min_length=1)


class ShopifyBatchProduct(BaseModel):
    id: str = Field(..., min_length=1)
    generated_image_base64: str = ""
    generated_image_mime_type: str = "image/png"
    title: str = Field(..., min_length=1)
    description: str = ""
    sku: str = Field(..., min_length=1)
    branch: str | None = None
    price: float | None = None
    compare_at_price: float | None = None
    sizes: list[ShopifyProductSizeQuantity] = Field(default_factory=list)
    media_items: list[PublishMediaItem] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    collection_ids: list[str] = Field(default_factory=list)


class ShopifyBatchPublishRequest(BaseModel):
    shop_id: str = Field(..., min_length=1)
    products: list[ShopifyBatchProduct] = Field(default_factory=list)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(request: LoginRequest, response: Response) -> dict[str, bool]:
    if not hmac.compare_digest(request.pin, VISUALOS_ADMIN_PIN):
        raise HTTPException(status_code=401, detail="Invalid PIN.")
    response.set_cookie(
        SESSION_COOKIE_NAME,
        _encode_session(),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return {"authenticated": True}


@app.post("/api/auth/logout")
def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"authenticated": False}


@app.get("/api/auth/session")
def session(request: Request) -> dict[str, bool]:
    return {"authenticated": _decode_session(request.cookies.get(SESSION_COOKIE_NAME)) is not None}


@app.get("/api/shops")
def list_shops(_session: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    return {"shops": [_shop_public(shop) for shop in _read_shops()]}


@app.post("/api/shops")
def create_shop(request: ShopWriteRequest, _session: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    shops = _read_shops()
    shop = _shop_from_request(request)
    if not shop["name"]:
        raise HTTPException(status_code=400, detail="Shop display name is required.")
    if any(item.get("shop_domain") == shop["shop_domain"] for item in shops):
        raise HTTPException(status_code=400, detail="A shop with this domain already exists.")
    shops.append(shop)
    _write_shops(shops)
    return {"shop": _shop_public(shop)}


@app.put("/api/shops/{shop_id}")
def update_shop(shop_id: str, request: ShopWriteRequest, _session: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    shops = _read_shops()
    existing_index = next((index for index, item in enumerate(shops) if item.get("id") == shop_id), None)
    if existing_index is None:
        raise HTTPException(status_code=404, detail="Shop not found.")
    shop = _shop_from_request(request, shops[existing_index])
    if not shop["name"]:
        raise HTTPException(status_code=400, detail="Shop display name is required.")
    if any(item.get("id") != shop_id and item.get("shop_domain") == shop["shop_domain"] for item in shops):
        raise HTTPException(status_code=400, detail="A shop with this domain already exists.")
    shops[existing_index] = shop
    _write_shops(shops)
    return {"shop": _shop_public(shop)}


@app.delete("/api/shops/{shop_id}")
def delete_shop(shop_id: str, _session: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    shops = _read_shops()
    next_shops = [shop for shop in shops if shop.get("id") != shop_id]
    if len(next_shops) == len(shops):
        raise HTTPException(status_code=404, detail="Shop not found.")
    _write_shops(next_shops)
    return {"deleted": True}


@app.get("/api/shops/{shop_id}/collections")
async def list_shop_collections(shop_id: str, _session: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    shop = _get_shop_private(shop_id)
    return {"collections": await _list_shopify_collections(shop)}


@app.post("/api/shops/{shop_id}/collections")
async def create_shop_collection(
    shop_id: str,
    request: CollectionCreateRequest,
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    shop = _get_shop_private(shop_id)
    return {"collection": await _create_shopify_collection(shop, request)}


@app.get("/api/config")
def style_config(_session: dict[str, Any] = Depends(require_auth)) -> dict[str, Any]:
    return load_style_config()


def _reference_name(filename: str) -> str:
    stem = Path(filename).stem.strip()
    return stem or "reference"


def _reference_role(filename: str, fallback: str) -> str:
    if fallback != "reference":
        return fallback
    name = _reference_name(filename).lower()
    if name.startswith("model"):
        return "model"
    if name.startswith("product"):
        return "product"
    return fallback


async def _read_references(files: list[UploadFile], role: str) -> list[ReferenceImage]:
    references: list[ReferenceImage] = []
    for file in files:
        mime_type = file.content_type or "application/octet-stream"
        if mime_type not in SUPPORTED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported image type for {file.filename}: {mime_type}",
            )
        references.append(
            {
                "name": _reference_name(file.filename or role),
                "role": _reference_role(file.filename or role, role),
                "path": file.filename or role,
                "mime_type": mime_type,
                "data": await file.read(),
            }
        )
    return references


def _parse_engine_params(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="engine_params must be valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="engine_params must be a JSON object.")
    return parsed


def _normalize_shop_domain(value: str) -> str:
    raw_value = value.strip().lower()
    if not raw_value:
        raise HTTPException(status_code=400, detail="Shopify store domain is required.")

    parsed = urlparse(raw_value if "://" in raw_value else f"https://{raw_value}")
    hostname = (parsed.hostname or "").strip(".")
    if not hostname.endswith(".myshopify.com") or hostname == "myshopify.com":
        raise HTTPException(
            status_code=400,
            detail="Only official *.myshopify.com store domains are supported.",
        )
    return hostname


def _shopify_mcp_url(shop_domain: str, endpoint_type: str) -> str:
    path = "/api/ucp/mcp" if endpoint_type == "ucp" else "/api/mcp"
    return f"https://{shop_domain}{path}"


def _shopify_admin_url(shop_domain: str, api_version: str | None = None) -> str:
    version = (api_version or SHOPIFY_ADMIN_API_VERSION).strip() or SHOPIFY_ADMIN_API_VERSION
    return f"https://{shop_domain}/admin/api/{version}/graphql.json"


def _shopify_admin_token(shop_domain: str, token_override: str | None = None) -> str:
    if token_override and token_override.strip():
        return token_override.strip()
    shop_specific_key = "SHOPIFY_ADMIN_ACCESS_TOKEN_" + shop_domain.replace(".myshopify.com", "").replace("-", "_").upper()
    return os.getenv(shop_specific_key) or os.getenv("SHOPIFY_ADMIN_ACCESS_TOKEN", "")


def _shopify_client_credentials(
    shop_domain: str,
    client_id_override: str | None = None,
    client_secret_override: str | None = None,
) -> tuple[str, str]:
    shop_key = shop_domain.replace(".myshopify.com", "").replace("-", "_").upper()
    client_id = (
        client_id_override
        or os.getenv(f"SHOPIFY_CLIENT_ID_{shop_key}")
        or SHOPIFY_CLIENT_ID
    )
    client_secret = (
        client_secret_override
        or os.getenv(f"SHOPIFY_CLIENT_SECRET_{shop_key}")
        or SHOPIFY_CLIENT_SECRET
    )
    return client_id.strip(), client_secret.strip()


async def _exchange_shopify_client_credentials(
    shop_domain: str,
    client_id: str,
    client_secret: str,
) -> str:
    cache_key = hashlib.sha256(f"{shop_domain}:{client_id}:{client_secret}".encode("utf-8")).hexdigest()
    cached = SHOPIFY_CLIENT_CREDENTIAL_TOKEN_CACHE.get(cache_key)
    now = time.time()
    if cached and cached.get("access_token") and cached.get("expires_at", 0) - SHOPIFY_TOKEN_REFRESH_MARGIN_SECONDS > now:
        return str(cached["access_token"])

    url = f"https://{shop_domain}/admin/oauth/access_token"
    try:
        async with httpx.AsyncClient(timeout=SHOPIFY_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers={"Accept": "application/json"},
                data={
                    "grant_type": "client_credentials",
                    "client_id": client_id,
                    "client_secret": client_secret,
                },
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=f"Shopify token exchange timed out for {url}.") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Shopify token endpoint {url}: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Shopify token endpoint returned a non-JSON response.",
                "endpoint": url,
                **_response_preview(response),
            },
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail={
                "message": f"Shopify token endpoint returned HTTP {response.status_code}.",
                "endpoint": url,
                "response": data,
                **_response_preview(response),
            },
        )

    access_token = data.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise HTTPException(
            status_code=502,
            detail={"message": "Shopify token endpoint did not return an access token.", "response": data},
        )

    expires_in = data.get("expires_in")
    expires_at = now + (expires_in if isinstance(expires_in, (int, float)) else 86400)
    SHOPIFY_CLIENT_CREDENTIAL_TOKEN_CACHE[cache_key] = {
        "access_token": access_token,
        "expires_at": expires_at,
        "scope": data.get("scope", ""),
    }
    return access_token


async def _resolve_shopify_admin_token(
    shop_domain: str,
    admin_access_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
) -> str:
    resolved_client_id, resolved_client_secret = _shopify_client_credentials(shop_domain, client_id, client_secret)
    if resolved_client_id and resolved_client_secret:
        return await _exchange_shopify_client_credentials(shop_domain, resolved_client_id, resolved_client_secret)

    token = _shopify_admin_token(shop_domain, admin_access_token)
    if token:
        return token

    shop_specific_suffix = shop_domain.replace(".myshopify.com", "").replace("-", "_").upper()
    raise HTTPException(
        status_code=400,
        detail=(
            "Missing Shopify auth credentials. Add Client ID and Client Secret in the UI, set SHOPIFY_CLIENT_ID/"
            "SHOPIFY_CLIENT_SECRET, or use a legacy Admin token via SHOPIFY_ADMIN_ACCESS_TOKEN"
            f" or SHOPIFY_ADMIN_ACCESS_TOKEN_{shop_specific_suffix}."
        ),
    )


def _image_filename(image_url: str) -> str:
    path = urlparse(image_url).path
    filename = Path(path).name
    return filename or "product-image.jpg"


def _json_rpc_payload(method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method, "id": 1}
    if params is not None:
        payload["params"] = params
    return payload


def _response_preview(response: httpx.Response) -> dict[str, Any]:
    response_text = response.text
    return {
        "status_code": response.status_code,
        "content_type": response.headers.get("content-type", ""),
        "content_length": response.headers.get("content-length", ""),
        "body_preview": response_text[:300].replace("\n", " "),
        "empty_body": not bool(response_text),
    }


def _check_shopify_user_errors(errors: list[dict[str, Any]] | None, operation: str) -> None:
    if not errors:
        return
    raise HTTPException(
        status_code=400,
        detail={
            "message": f"Failed to {operation}.",
            "user_errors": errors,
        },
    )


def _format_variant_price(price: float | None) -> str:
    return f"{price or 0:.2f}"


def _format_optional_variant_price(price: float | None) -> str | None:
    if price is None:
        return None
    return f"{price:.2f}"


def _shop_credentials(shop: dict[str, Any]) -> dict[str, str]:
    return {
        "admin_access_token": shop.get("admin_access_token", ""),
        "shopify_client_id": shop.get("shopify_client_id", ""),
        "shopify_client_secret": shop.get("shopify_client_secret", ""),
        "admin_api_version": shop.get("admin_api_version", SHOPIFY_ADMIN_API_VERSION),
        "location_id": shop.get("location_id", ""),
        "publication_id": shop.get("publication_id", ""),
    }


def _decode_base64_image(image_base64: str) -> bytes:
    payload = image_base64.split(",", 1)[1] if "," in image_base64[:80] else image_base64
    try:
        return base64.b64decode(payload, validate=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Image payload must be valid base64.") from exc


def _image_extension(mime_type: str) -> str:
    normalized = mime_type.lower().split(";", 1)[0].strip()
    if normalized == "image/jpeg":
        return "jpg"
    if normalized == "image/webp":
        return "webp"
    return "png"


def _safe_filename(value: str, mime_type: str) -> str:
    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-._") or "product-image"
    return f"{stem[:80]}.{_image_extension(mime_type)}"


def _idempotency_key(prefix: str, payload: Any) -> str:
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
    return f"{prefix}-{digest[:48]}"


def _extract_text_response(response: Any) -> str:
    if getattr(response, "text", None):
        return str(response.text).strip()
    parts = []
    if getattr(response, "parts", None):
        parts = list(response.parts)
    else:
        for candidate in getattr(response, "candidates", []) or []:
            content = getattr(candidate, "content", None)
            parts.extend(getattr(content, "parts", []) or [])
    texts = [str(getattr(part, "text", "")).strip() for part in parts if getattr(part, "text", None)]
    return "\n".join(text for text in texts if text).strip()


def _parse_json_object_text(text: str) -> dict[str, Any]:
    clean_text = text.strip()
    if clean_text.startswith("```"):
        clean_text = re.sub(r"^```(?:json)?", "", clean_text).strip()
        clean_text = re.sub(r"```$", "", clean_text).strip()
    match = re.search(r"\{.*\}", clean_text, flags=re.DOTALL)
    if match:
        clean_text = match.group(0)
    try:
        parsed = json.loads(clean_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail={"message": "Gemini metadata response was not valid JSON.", "response": text},
        ) from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=502, detail={"message": "Gemini metadata response must be a JSON object.", "response": text})
    return parsed


async def _call_shopify_admin_graphql(
    shop_domain: str,
    query: str,
    variables: dict[str, Any] | None = None,
    admin_access_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    api_version: str | None = None,
) -> dict[str, Any]:
    token = await _resolve_shopify_admin_token(shop_domain, admin_access_token, client_id, client_secret)

    url = _shopify_admin_url(shop_domain, api_version)
    try:
        async with httpx.AsyncClient(timeout=SHOPIFY_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": token,
                },
                json={"query": query, "variables": variables or {}},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=f"Shopify Admin request timed out for {url}.") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Shopify Admin endpoint {url}: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Shopify Admin returned a non-JSON response.",
                "endpoint": url,
                **_response_preview(response),
            },
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=response.status_code,
            detail={
                "message": f"Shopify Admin endpoint returned HTTP {response.status_code}.",
                "endpoint": url,
                "response": data,
                **_response_preview(response),
            },
        )
    if data.get("errors"):
        raise HTTPException(status_code=502, detail={"message": "Shopify Admin GraphQL errors.", "errors": data["errors"]})
    return data


async def _upload_shopify_product_image(
    shop_domain: str,
    image_bytes: bytes,
    mime_type: str,
    filename: str,
    admin_access_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    api_version: str | None = None,
) -> dict[str, Any]:
    staged_data = await _call_shopify_admin_graphql(
        shop_domain,
        """
        mutation VisualOSStagedUpload($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets {
              url
              resourceUrl
              parameters {
                name
                value
              }
            }
            userErrors {
              field
              message
            }
          }
        }
        """,
        {
            "input": [
                {
                    "resource": "IMAGE",
                    "filename": filename,
                    "mimeType": mime_type,
                    "httpMethod": "POST",
                }
            ]
        },
        admin_access_token=admin_access_token,
        client_id=client_id,
        client_secret=client_secret,
        api_version=api_version,
    )
    staged_result = staged_data.get("data", {}).get("stagedUploadsCreate", {})
    _check_shopify_user_errors(staged_result.get("userErrors"), "stage product image upload")
    staged_targets = staged_result.get("stagedTargets") or []
    if not staged_targets:
        raise HTTPException(status_code=502, detail={"message": "Shopify did not return a staged upload target.", "response": staged_data})

    target = staged_targets[0]
    upload_url = target.get("url")
    resource_url = target.get("resourceUrl")
    if not upload_url or not resource_url:
        raise HTTPException(status_code=502, detail={"message": "Shopify staged upload target was incomplete.", "target": target})

    form_data = {item["name"]: item["value"] for item in target.get("parameters", []) if item.get("name") is not None}
    try:
        async with httpx.AsyncClient(timeout=SHOPIFY_TIMEOUT_SECONDS * 3) as client:
            response = await client.post(
                upload_url,
                data=form_data,
                files={"file": (filename, image_bytes, mime_type)},
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=f"Shopify staged image upload timed out for {upload_url}.") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not upload staged image to Shopify: {exc}") from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail={
                "message": f"Shopify staged image upload returned HTTP {response.status_code}.",
                "upload_url": upload_url,
                **_response_preview(response),
            },
        )

    return {
        "filename": filename,
        "mime_type": mime_type,
        "resource_url": resource_url,
        "upload_status_code": response.status_code,
    }


async def _resolve_shopify_location_id(
    shop_domain: str,
    branch: str | None,
    admin_access_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    api_version: str | None = None,
    fallback_location_id: str | None = None,
) -> str | None:
    branch_value = (branch or "").strip()
    if branch_value.startswith("gid://shopify/Location/"):
        return branch_value
    configured_location_id = (fallback_location_id or SHOPIFY_ADMIN_LOCATION_ID).strip()
    if not branch_value and configured_location_id.startswith("gid://shopify/Location/"):
        return configured_location_id
    if not branch_value and configured_location_id:
        branch_value = configured_location_id
    if not branch_value:
        return None

    try:
        locations_data = await _call_shopify_admin_graphql(
            shop_domain,
            """
            query LocationsForVisualOS {
              locations(first: 100) {
                nodes {
                  id
                  name
                  isActive
                }
              }
            }
            """,
            admin_access_token=admin_access_token,
            client_id=client_id,
            client_secret=client_secret,
            api_version=api_version,
        )
    except HTTPException as exc:
        detail = exc.detail
        errors = detail.get("errors") if isinstance(detail, dict) else None
        if errors and any("Access denied for locations field" in str(error.get("message", "")) for error in errors if isinstance(error, dict)):
            raise HTTPException(
                status_code=403,
                detail={
                    "message": (
                        "Your Shopify app is missing access to locations. Add the read_locations scope, "
                        "or paste a Location ID instead of a branch name."
                    ),
                    "scope_required": "read_locations",
                    "location_id_format": "gid://shopify/Location/...",
                    "shopify_error": detail,
                },
            ) from exc
        raise
    locations = locations_data.get("data", {}).get("locations", {}).get("nodes", [])
    active_locations = [location for location in locations if location.get("isActive")]
    if branch_value:
        match = next((location for location in active_locations if location.get("name", "").lower() == branch_value.lower()), None)
        if not match:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": f"No active Shopify location matched branch '{branch_value}'.",
                    "available_branches": [location.get("name") for location in active_locations],
                },
            )
        return match["id"]
    if active_locations:
        return active_locations[0]["id"]
    return None


async def _publish_product_to_publication(
    shop_domain: str,
    product_id: str,
    publication_id: str | None = None,
    admin_access_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    api_version: str | None = None,
) -> dict[str, Any] | None:
    resolved_publication_id = (publication_id or SHOPIFY_ADMIN_PUBLICATION_ID).strip()
    if not resolved_publication_id:
        return None
    data = await _call_shopify_admin_graphql(
        shop_domain,
        """
        mutation PublishProductForVisualOS($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            publishable {
              availablePublicationsCount {
                count
              }
              resourcePublicationsCount {
                count
              }
            }
            userErrors {
              field
              message
            }
          }
        }
        """,
        {"id": product_id, "input": [{"publicationId": resolved_publication_id}]},
        admin_access_token=admin_access_token,
        client_id=client_id,
        client_secret=client_secret,
        api_version=api_version,
    )
    publish_result = data.get("data", {}).get("publishablePublish", {})
    user_errors = publish_result.get("userErrors") or []
    if user_errors:
        raise HTTPException(status_code=400, detail={"message": "Shopify could not publish the product.", "user_errors": user_errors})
    return publish_result


async def _list_shopify_collections(shop: dict[str, Any]) -> list[dict[str, Any]]:
    credentials = _shop_credentials(shop)
    data = await _call_shopify_admin_graphql(
        shop["shop_domain"],
        """
        query VisualOSCollections {
          collections(first: 100, sortKey: TITLE) {
            nodes {
              id
              title
              handle
              updatedAt
            }
          }
        }
        """,
        admin_access_token=credentials["admin_access_token"],
        client_id=credentials["shopify_client_id"],
        client_secret=credentials["shopify_client_secret"],
        api_version=credentials["admin_api_version"],
    )
    return data.get("data", {}).get("collections", {}).get("nodes", []) or []


async def _create_shopify_collection(shop: dict[str, Any], request: CollectionCreateRequest) -> dict[str, Any]:
    credentials = _shop_credentials(shop)
    data = await _call_shopify_admin_graphql(
        shop["shop_domain"],
        """
        mutation VisualOSCollectionCreate($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection {
              id
              title
              handle
              updatedAt
            }
            userErrors {
              field
              message
            }
          }
        }
        """,
        {"input": {"title": request.title.strip(), "descriptionHtml": request.description.strip()}},
        admin_access_token=credentials["admin_access_token"],
        client_id=credentials["shopify_client_id"],
        client_secret=credentials["shopify_client_secret"],
        api_version=credentials["admin_api_version"],
    )
    result = data.get("data", {}).get("collectionCreate", {})
    _check_shopify_user_errors(result.get("userErrors"), "create collection")
    collection = result.get("collection")
    if not collection:
        raise HTTPException(status_code=502, detail={"message": "Shopify did not return a created collection.", "response": data})
    return collection


async def _create_shopify_base_product(
    shop_domain: str,
    request: ShopifyProductPublishRequest,
    size_rows: list[ShopifyProductSizeQuantity],
) -> dict[str, Any]:
    product_input: dict[str, Any] = {
        "title": request.title.strip(),
        "descriptionHtml": request.desc.strip(),
        "status": "ACTIVE",
        "productOptions": [
            {
                "name": "Size",
                "values": [{"name": row.size.strip()} for row in size_rows],
            }
        ],
    }
    if request.tags:
        product_input["tags"] = request.tags
    if request.collection_ids:
        product_input["collectionsToJoin"] = request.collection_ids

    media = []
    media_sources = request.media_urls or ([request.img.strip()] if request.img.strip() else [])
    for index, media_url in enumerate(media_sources):
        if not media_url:
            continue
        media.append(
            {
                "mediaContentType": "IMAGE",
                "originalSource": media_url,
                "alt": request.title.strip() if index == 0 else f"{request.title.strip()} image {index + 1}",
            }
        )

    data = await _call_shopify_admin_graphql(
        shop_domain,
        """
        mutation CreateVisualOSProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
          productCreate(product: $product, media: $media) {
            product {
              id
              title
              handle
              descriptionHtml
              status
              options {
                id
                name
                position
                optionValues {
                  id
                  name
                  hasVariants
                }
              }
              onlineStoreUrl
              onlineStorePreviewUrl
              media(first: 20) {
                nodes {
                  id
                  alt
                  mediaContentType
                  status
                }
              }
              variants(first: 100) {
                nodes {
                  id
                  title
                  price
                  inventoryQuantity
                  inventoryItem {
                    sku
                  }
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
        """,
        {"product": product_input, "media": media or None},
        admin_access_token=request.admin_access_token,
        client_id=request.shopify_client_id,
        client_secret=request.shopify_client_secret,
        api_version=request.admin_api_version,
    )
    product_create_result = data.get("data", {}).get("productCreate", {})
    _check_shopify_user_errors(product_create_result.get("userErrors"), "create product")
    product = product_create_result.get("product")
    if not product:
        raise HTTPException(status_code=502, detail={"message": "Shopify did not return a created product.", "response": data})
    return product


async def _create_shopify_product_variants(
    shop_domain: str,
    request: ShopifyProductPublishRequest,
    product_id: str,
    size_rows: list[ShopifyProductSizeQuantity],
) -> list[dict[str, Any]]:
    base_sku = request.sku.strip()
    variants = []
    for row in size_rows:
        size = row.size.strip()
        inventory_item: dict[str, Any] = {
            "sku": base_sku if len(size_rows) == 1 else f"{base_sku}-{size}",
            "tracked": True,
        }
        variants.append(
            {
                "price": _format_variant_price(request.price),
                "inventoryItem": inventory_item,
                "optionValues": [{"optionName": "Size", "name": size}],
            }
        )
        compare_at_price = _format_optional_variant_price(request.compare_at_price)
        if compare_at_price:
            variants[-1]["compareAtPrice"] = compare_at_price

    data = await _call_shopify_admin_graphql(
        shop_domain,
        """
        mutation CreateVisualOSVariants(
          $productId: ID!
          $variants: [ProductVariantsBulkInput!]!
          $strategy: ProductVariantsBulkCreateStrategy
        ) {
          productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
            productVariants {
              id
              title
              price
              compareAtPrice
              selectedOptions {
                name
                value
              }
              inventoryItem {
                id
                sku
              }
            }
            userErrors {
              field
              message
            }
          }
        }
        """,
        {
            "productId": product_id,
            "variants": variants,
            "strategy": "REMOVE_STANDALONE_VARIANT",
        },
        admin_access_token=request.admin_access_token,
        client_id=request.shopify_client_id,
        client_secret=request.shopify_client_secret,
        api_version=request.admin_api_version,
    )
    variants_result = data.get("data", {}).get("productVariantsBulkCreate", {})
    _check_shopify_user_errors(variants_result.get("userErrors"), "create variants")
    return variants_result.get("productVariants") or []


async def _set_shopify_inventory_quantities(
    shop_domain: str,
    request: ShopifyProductPublishRequest,
    location_id: str | None,
    variants: list[dict[str, Any]],
    size_rows: list[ShopifyProductSizeQuantity],
) -> dict[str, Any]:
    if not location_id:
        return {
            "status": "skipped",
            "reason": "missing_location_id",
            "message": "Inventory was skipped because no Shopify Location ID or resolvable branch was provided.",
        }

    quantities = []
    for variant, row in zip(variants, size_rows, strict=False):
        inventory_item_id = variant.get("inventoryItem", {}).get("id")
        if not inventory_item_id:
            continue
        quantities.append(
            {
                "inventoryItemId": inventory_item_id,
                "locationId": location_id,
                "quantity": row.qty,
                "changeFromQuantity": None,
            }
        )
    if not quantities:
        return {
            "status": "skipped",
            "reason": "missing_inventory_item_ids",
            "message": "Inventory was skipped because Shopify did not return inventory item IDs for the created variants.",
        }

    activation_results = []
    for quantity in quantities:
        activation_variables = {
            "inventoryItemId": quantity["inventoryItemId"],
            "locationId": quantity["locationId"],
            "available": quantity["quantity"],
        }
        activation_variables["idempotencyKey"] = _idempotency_key("visualos-activate", activation_variables)
        activation_data = await _call_shopify_admin_graphql(
            shop_domain,
            """
            mutation ActivateVisualOSInventory(
              $inventoryItemId: ID!
              $locationId: ID!
              $available: Int
              $idempotencyKey: String!
            ) {
              inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available)
                @idempotent(key: $idempotencyKey) {
                inventoryLevel {
                  id
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                  item {
                    id
                    sku
                  }
                  location {
                    id
                    name
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
            """,
            activation_variables,
            admin_access_token=request.admin_access_token,
            client_id=request.shopify_client_id,
            client_secret=request.shopify_client_secret,
            api_version=request.admin_api_version,
        )
        activation_result = activation_data.get("data", {}).get("inventoryActivate", {})
        activation_results.append(
            {
                "inventory_item_id": quantity["inventoryItemId"],
                "inventory_level": activation_result.get("inventoryLevel"),
                "user_errors": activation_result.get("userErrors") or [],
            }
        )

    if activation_results and not any(result["user_errors"] for result in activation_results):
        return {
            "status": "activated",
            "location_id": location_id,
            "activation_results": activation_results,
        }

    set_input = {
        "reason": "correction",
        "name": "available",
        "quantities": quantities,
    }
    data = await _call_shopify_admin_graphql(
        shop_domain,
        """
        mutation SetVisualOSInventory($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
          inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup {
              reason
              changes {
                name
                delta
                quantityAfterChange
                item {
                  id
                  sku
                }
                location {
                  id
                  name
                }
              }
            }
            userErrors {
              field
              message
              code
            }
          }
        }
        """,
        {
            "input": set_input,
            "idempotencyKey": _idempotency_key("visualos-set", set_input),
        },
        admin_access_token=request.admin_access_token,
        client_id=request.shopify_client_id,
        client_secret=request.shopify_client_secret,
        api_version=request.admin_api_version,
    )
    inventory_result = data.get("data", {}).get("inventorySetQuantities", {})
    _check_shopify_user_errors(inventory_result.get("userErrors"), "set inventory quantities")
    return {
        "status": "set",
        "location_id": location_id,
        "activation_results": activation_results,
        "inventory_adjustment_group": inventory_result.get("inventoryAdjustmentGroup"),
    }


async def _create_shopify_product(shop_domain: str, request: ShopifyProductPublishRequest) -> dict[str, Any]:
    size_rows = request.sizes or [ShopifyProductSizeQuantity(size="One Size", qty=0)]
    location_id = await _resolve_shopify_location_id(
        shop_domain,
        request.branch,
        admin_access_token=request.admin_access_token,
        client_id=request.shopify_client_id,
        client_secret=request.shopify_client_secret,
        api_version=request.admin_api_version,
        fallback_location_id=request.location_id,
    )

    product = await _create_shopify_base_product(shop_domain, request, size_rows)
    variants = await _create_shopify_product_variants(shop_domain, request, product["id"], size_rows)
    inventory_adjustment = await _set_shopify_inventory_quantities(shop_domain, request, location_id, variants, size_rows)

    publish_result = await _publish_product_to_publication(
        shop_domain,
        product["id"],
        publication_id=request.publication_id,
        admin_access_token=request.admin_access_token,
        client_id=request.shopify_client_id,
        client_secret=request.shopify_client_secret,
        api_version=request.admin_api_version,
    )
    return {
        "shop_domain": shop_domain,
        "product": product,
        "published": bool(publish_result),
        "publication_configured": bool((request.publication_id or SHOPIFY_ADMIN_PUBLICATION_ID).strip()),
        "publication": publish_result,
        "location_id": location_id,
        "variants": variants,
        "inventory_adjustment": inventory_adjustment,
    }


def _prepare_ucp_arguments(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    prepared = dict(arguments)
    if "catalog" not in prepared:
        catalog_keys = set(prepared) - {"meta"}
        prepared["catalog"] = {key: prepared.pop(key) for key in catalog_keys}

    meta = dict(prepared.get("meta") or {})
    ucp_agent = dict(meta.get("ucp-agent") or {})
    ucp_agent.setdefault("profile", SHOPIFY_AGENT_PROFILE)
    meta["ucp-agent"] = ucp_agent
    prepared["meta"] = meta
    return prepared


async def _call_shopify_mcp(
    shop_domain: str,
    endpoint_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    url = _shopify_mcp_url(shop_domain, endpoint_type)
    try:
        async with httpx.AsyncClient(timeout=SHOPIFY_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail=f"Shopify MCP request timed out for {url}.",
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach Shopify MCP endpoint {url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        try:
            response_json = response.json()
        except ValueError:
            response_json = None
        raise HTTPException(
            status_code=response.status_code,
            detail={
                "message": f"Shopify MCP endpoint returned HTTP {response.status_code}.",
                "endpoint": url,
                "response": response_json,
                **_response_preview(response),
            },
        )

    try:
        response_json = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Shopify returned a successful HTTP response, but the body was not JSON.",
                "endpoint": url,
                **_response_preview(response),
            },
        ) from exc

    return {
        "endpoint": url,
        "status_code": response.status_code,
        "ok": "error" not in response_json,
        "response": response_json,
    }


@app.post("/api/generate")
async def generate(
    initial_prompt: str = Form(...),
    style_genre: str = Form("high_end_ecommerce"),
    moodboard_grading: str = Form("flash_editorial"),
    framing: str = Form("full_body"),
    camera_angle: str = Form("eye_level"),
    lens_focal_length: str = Form("auto"),
    lighting_setup: str = Form("softbox_diffused"),
    environment_setting: str = Form("seamless_neutral"),
    engine_params: str | None = Form(None),
    size: str = Form("1K"),
    aspect_ratio: str = Form("4:5"),
    product_images: list[UploadFile] = File(default=[]),
    model_images: list[UploadFile] = File(default=[]),
    reference_images: list[UploadFile] = File(default=[]),
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    if not initial_prompt.strip():
        raise HTTPException(status_code=400, detail="initial_prompt is required.")

    model_refs = await _read_references(model_images, "model")
    product_refs = await _read_references(product_images, "product")
    generic_refs = await _read_references(reference_images, "reference")
    references = model_refs + product_refs + generic_refs
    model_paths = [ref["path"] for ref in references if ref["role"] == "model"]
    product_paths = [ref["path"] for ref in references if ref["role"] == "product"]

    graph = build_graph()
    final_state = graph.invoke(
        {
            "initial_prompt": initial_prompt.strip(),
            "products_img_paths": product_paths,
            "model_img_paths": model_paths,
            "reference_images": references,
            "style_genre": style_genre,
            "moodboard_grading": moodboard_grading,
            "framing": framing,
            "camera_angle": camera_angle,
            "lens_focal_length": lens_focal_length,
            "lighting_setup": lighting_setup,
            "environment_setting": environment_setting,
            "engine_params": _parse_engine_params(engine_params),
            "size": size,
            "aspect_ratio": aspect_ratio,
            "refined_prompt": "",
            "output_image": None,
            "output_mime_type": "image/png",
        }
    )

    output_image = final_state.get("output_image")
    if not output_image:
        raise HTTPException(status_code=502, detail="No image was returned by Gemini.")

    mime_type = final_state.get("output_mime_type", "image/png")
    return {
        "refined_prompt": final_state.get("refined_prompt", ""),
        "reference_mapping": final_state.get("reference_mapping", ""),
        "mime_type": mime_type,
        "image_base64": base64.b64encode(output_image).decode("utf-8"),
    }


@app.post("/api/products/generate-image")
async def generate_product_image(
    sku: str = Form(""),
    image_mode: str = Form("photoshoot"),
    user_hints: str = Form(""),
    prompt_template: str = Form(""),
    style_genre: str = Form("high_end_ecommerce"),
    moodboard_grading: str = Form("flash_editorial"),
    framing: str = Form("full_body"),
    camera_angle: str = Form("eye_level"),
    lens_focal_length: str = Form("auto"),
    lighting_setup: str = Form("softbox_diffused"),
    environment_setting: str = Form("seamless_neutral"),
    engine_params: str | None = Form(None),
    size: str = Form("1K"),
    aspect_ratio: str = Form("4:5"),
    product_images: list[UploadFile] = File(default=[]),
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    mode = image_mode.strip().lower()
    if mode not in {"photoshoot", "flat_lay"}:
        raise HTTPException(status_code=400, detail="image_mode must be either photoshoot or flat_lay.")
    if not product_images:
        raise HTTPException(status_code=400, detail="Upload at least one product image.")

    product_refs = await _read_references(product_images, "product")
    product_names = ", ".join(f"({ref['name']})" for ref in product_refs)
    hint_text = user_hints.strip()
    if prompt_template.strip():
        initial_prompt = prompt_template.strip().format(
            sku=sku or "unspecified",
            product_references=product_names,
            notes=hint_text or "none",
        )
    elif mode == "flat_lay":
        initial_prompt = (
            f"Create a clean premium e-commerce flat-lay image for SKU {sku or 'unspecified'}. "
            f"Use product references {product_names}. Arrange the product naturally from a true overhead angle on a refined neutral surface. "
            "No model, no mannequin, no hands, no extra props unless they are minimal and do not distract. Preserve the product identity, "
            "materials, silhouette, colors, and design details. The final image should feel ready for a Shopify product page."
        )
        framing = "product_detail"
        camera_angle = "top_down"
        environment_setting = "seamless_neutral"
    else:
        initial_prompt = (
            f"Create a premium Shopify product photoshoot image for SKU {sku or 'unspecified'}. "
            f"Use product references {product_names}. Preserve the product identity, materials, silhouette, colors, and design details. "
            "Make it polished, realistic, commercial, and ready for an e-commerce product page."
        )
    if hint_text and not prompt_template.strip():
        initial_prompt = f"{initial_prompt} User notes: {hint_text}"

    graph = build_graph()
    final_state = graph.invoke(
        {
            "initial_prompt": initial_prompt,
            "products_img_paths": [ref["path"] for ref in product_refs],
            "model_img_paths": [],
            "reference_images": product_refs,
            "style_genre": style_genre,
            "moodboard_grading": moodboard_grading,
            "framing": framing,
            "camera_angle": camera_angle,
            "lens_focal_length": lens_focal_length,
            "lighting_setup": lighting_setup,
            "environment_setting": environment_setting,
            "engine_params": _parse_engine_params(engine_params),
            "size": size,
            "aspect_ratio": aspect_ratio,
            "refined_prompt": "",
            "output_image": None,
            "output_mime_type": "image/png",
        }
    )
    output_image = final_state.get("output_image")
    if not output_image:
        raise HTTPException(status_code=502, detail="No image was returned by Gemini.")

    mime_type = final_state.get("output_mime_type", "image/png")
    return {
        "image_mode": mode,
        "refined_prompt": final_state.get("refined_prompt", ""),
        "reference_mapping": final_state.get("reference_mapping", ""),
        "mime_type": mime_type,
        "image_base64": base64.b64encode(output_image).decode("utf-8"),
    }


@app.post("/api/products/generate-metadata")
async def generate_product_metadata(
    request: ProductMetadataRequest,
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, str]:
    image_bytes = _decode_base64_image(request.image_base64)
    try:
        image = Image.open(BytesIO(image_bytes))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Generated image could not be read.") from exc

    prompt = f"""You are an expert Shopify catalog copywriter.
Analyze the product image and return strict JSON only with:
{{"title":"...", "description":"..."}}

Requirements:
- Title should be concise, searchable, and product-page ready.
- Description should be 2-4 polished sentences focused on visible product features.
- Do not invent brand names, materials, sizes, or claims that are not visually supported.
- Title prompt: {request.title_prompt or "Use a concise SEO-friendly product title."}
- Description prompt: {request.description_prompt or "Describe visible product features in polished Shopify product-page copy."}
- SKU/context: {request.sku or "unspecified"}
- User hints: {request.hints or "none"}"""
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    response = client.models.generate_content(
        model=os.getenv("GEMINI_METADATA_MODEL", os.getenv("GEMINI_PROMPT_MODEL", "gemini-3-flash-preview")),
        contents=[prompt, image],
        config=types.GenerateContentConfig(response_modalities=["TEXT"]),
    )
    parsed = _parse_json_object_text(_extract_text_response(response))
    return {
        "title": str(parsed.get("title", "")).strip(),
        "description": str(parsed.get("description", "")).strip(),
    }


async def _publish_one_batch_product(shop_domain: str, request: ShopifyBatchPublishRequest, product: ShopifyBatchProduct) -> dict[str, Any]:
    shop = _get_shop_private(request.shop_id)
    credentials = _shop_credentials(shop)
    media_items = product.media_items
    if not media_items and product.generated_image_base64:
        media_items = [
            PublishMediaItem(
                id="generated",
                kind="generated",
                filename=_safe_filename(product.sku, product.generated_image_mime_type),
                mime_type=product.generated_image_mime_type,
                image_base64=product.generated_image_base64,
            )
        ]
    if not media_items:
        raise HTTPException(status_code=400, detail="At least one media item is required.")

    media_uploads = []
    for index, media_item in enumerate(media_items):
        filename = _safe_filename(media_item.filename or f"{product.sku}-{index + 1}", media_item.mime_type)
        media_uploads.append(
            await _upload_shopify_product_image(
                shop_domain,
                _decode_base64_image(media_item.image_base64),
                media_item.mime_type,
                filename,
                admin_access_token=credentials["admin_access_token"],
                client_id=credentials["shopify_client_id"],
                client_secret=credentials["shopify_client_secret"],
                api_version=credentials["admin_api_version"],
            )
        )
    publish_request = ShopifyProductPublishRequest(
        shop_domain=shop_domain,
        shopify_client_id=credentials["shopify_client_id"],
        shopify_client_secret=credentials["shopify_client_secret"],
        admin_access_token=credentials["admin_access_token"],
        admin_api_version=credentials["admin_api_version"],
        location_id=credentials["location_id"],
        publication_id=credentials["publication_id"],
        img=media_uploads[0]["resource_url"],
        media_urls=[item["resource_url"] for item in media_uploads],
        desc=product.description,
        title=product.title,
        sku=product.sku,
        branch=product.branch,
        price=product.price,
        compare_at_price=product.compare_at_price,
        sizes=product.sizes,
        tags=product.tags,
        collection_ids=product.collection_ids,
    )
    result = await _create_shopify_product(shop_domain, publish_request)
    inventory_result = result.get("inventory_adjustment") or {}
    return {
        "local_id": product.id,
        "ok": True,
        "product": result.get("product"),
        "variants": result.get("variants", []),
        "variant_count": len(result.get("variants", [])),
        "media_uploads": media_uploads,
        "media_status": "uploaded",
        "media_count": len(media_uploads),
        "tags": product.tags,
        "collection_ids": product.collection_ids,
        "inventory_status": inventory_result.get("status", "unknown"),
        "inventory": inventory_result,
        "location_id": result.get("location_id"),
        "published": result.get("published", False),
        "publication": result.get("publication"),
    }


@app.post("/api/products/publish-batch")
async def publish_product_batch(
    request: ShopifyBatchPublishRequest,
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    shop = _get_shop_private(request.shop_id)
    shop_domain = _normalize_shop_domain(shop["shop_domain"])
    if not request.products:
        raise HTTPException(status_code=400, detail="At least one approved product is required.")

    results = []
    for product in request.products:
        try:
            results.append(await _publish_one_batch_product(shop_domain, request, product))
        except HTTPException as exc:
            results.append(
                {
                    "local_id": product.id,
                    "ok": False,
                    "error": exc.detail,
                    "status_code": exc.status_code,
                }
            )
        except Exception as exc:
            results.append(
                {
                    "local_id": product.id,
                    "ok": False,
                    "error": str(exc),
                    "status_code": 500,
                }
            )

    return {
        "shop_domain": shop_domain,
        "total": len(results),
        "succeeded": sum(1 for result in results if result.get("ok")),
        "failed": sum(1 for result in results if not result.get("ok")),
        "results": results,
    }


@app.post("/api/shopify-mcp/test")
async def test_shopify_mcp(
    request: ShopifyMcpTestRequest,
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    shop_domain = _normalize_shop_domain(request.shop_domain)
    test_payload = _json_rpc_payload("tools/list")

    async def probe(endpoint_type: str) -> dict[str, Any]:
        try:
            return await _call_shopify_mcp(shop_domain, endpoint_type, test_payload)
        except HTTPException as exc:
            return {
                "endpoint": _shopify_mcp_url(shop_domain, endpoint_type),
                "status_code": exc.status_code,
                "ok": False,
                "error": exc.detail,
            }

    standard = await probe("standard")
    ucp = await probe("ucp")
    return {
        "shop_domain": shop_domain,
        "standard": standard,
        "ucp": ucp,
    }


@app.post("/api/shopify-mcp/call")
async def call_shopify_mcp(
    request: ShopifyMcpCallRequest,
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    shop_domain = _normalize_shop_domain(request.shop_domain)
    tool = request.tool.strip()
    endpoint_type = SHOPIFY_TOOL_ENDPOINTS.get(tool)
    if endpoint_type is None:
        raise HTTPException(status_code=400, detail=f"Unsupported Shopify MCP tool: {tool}")

    arguments = dict(request.arguments)
    if endpoint_type == "ucp":
        arguments = _prepare_ucp_arguments(tool, arguments)

    payload = _json_rpc_payload(
        "tools/call",
        {
            "name": tool,
            "arguments": arguments,
        },
    )
    result = await _call_shopify_mcp(shop_domain, endpoint_type, payload)
    return {
        "shop_domain": shop_domain,
        "tool": tool,
        "endpoint_type": endpoint_type,
        **result,
    }


@app.post("/api/shopify-admin/products")
async def publish_shopify_product(
    request: ShopifyProductPublishRequest,
    _session: dict[str, Any] = Depends(require_auth),
) -> dict[str, Any]:
    shop_domain = _normalize_shop_domain(request.shop_domain)
    return await _create_shopify_product(shop_domain, request)
