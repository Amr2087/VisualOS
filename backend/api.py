import base64
import json
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .config import load_style_config
from .graph import build_graph
from .state import ReferenceImage

load_dotenv()

SUPPORTED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp"}

app = FastAPI(title="VisualOS API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/config")
def style_config() -> dict[str, Any]:
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
    aspect_ratio: str = Form("1:1"),
    product_images: list[UploadFile] = File(default=[]),
    model_images: list[UploadFile] = File(default=[]),
    reference_images: list[UploadFile] = File(default=[]),
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
