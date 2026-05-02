import os
from io import BytesIO

from dotenv import load_dotenv
from google import genai
from google.genai import types
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from PIL import Image

from .prompts import build_refine_messages, build_reference_mapping
from .state import PhotoshootState

load_dotenv()


PROMPT_MODEL = os.getenv("GEMINI_PROMPT_MODEL", "gemini-3-flash-preview")
IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image-preview")


def prepare_references_node(state: PhotoshootState) -> dict:
    return {"reference_mapping": build_reference_mapping(state)}


def refine_prompt_node(state: PhotoshootState) -> dict:
    system_prompt, user_prompt = build_refine_messages(state)
    llm = ChatGoogleGenerativeAI(
        model=PROMPT_MODEL,
        temperature=0.7,
        google_api_key=os.getenv("GEMINI_API_KEY"),
    )
    response = llm.invoke(
        [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]
    )
    return {"refined_prompt": str(response.content).strip()}


def _response_parts(response) -> list:
    if getattr(response, "parts", None):
        return list(response.parts)
    parts = []
    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        parts.extend(getattr(content, "parts", []) or [])
    return parts


def _extract_image_bytes(response) -> tuple[bytes, str]:
    for part in _response_parts(response):
        inline_data = getattr(part, "inline_data", None)
        if inline_data is not None:
            mime_type = getattr(inline_data, "mime_type", "image/png") or "image/png"
            return inline_data.data, mime_type
    raise RuntimeError("Gemini did not return an image.")


def generate_image_node(state: PhotoshootState) -> dict:
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    contents: list = [state["refined_prompt"]]
    for ref in state.get("reference_images", []):
        image = Image.open(BytesIO(ref["data"]))
        contents.append(image)

    image_config_kwargs = {"aspect_ratio": state.get("aspect_ratio", "1:1")}
    size = state.get("size")
    if size:
        image_config_kwargs["image_size"] = size

    response = client.models.generate_content(
        model=IMAGE_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
            image_config=types.ImageConfig(**image_config_kwargs),
        ),
    )
    image_bytes, mime_type = _extract_image_bytes(response)
    return {"output_image": image_bytes, "output_mime_type": mime_type}
