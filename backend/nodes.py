from io import BytesIO

from google import genai
from google.genai import types
from PIL import Image

from .prompts import build_refine_system_prompt
from .state import PhotoState


def refine_prompt_node(state: PhotoState) -> dict:
    client = genai.Client()
    system = build_refine_system_prompt(
        state["styles"],
        state["lighting"],
        state["framing"],
        state["mood"],
        state["aspect_ratio"],
        edit_mode=bool(state["input_images"]),
        n_inputs=len(state["input_images"]),
    )
    resp = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=state["description"],
        config=types.GenerateContentConfig(system_instruction=system),
    )
    return {"refined_prompt": resp.text.strip()}


def generate_image_node(state: PhotoState) -> dict:
    client = genai.Client()
    contents: list = [state["refined_prompt"]]
    for img_bytes in state["input_images"]:
        contents.append(Image.open(BytesIO(img_bytes)))
    resp = client.models.generate_content(
        model="gemini-3.1-flash-image-preview",
        contents=contents,
    )
    image_bytes = None
    for part in resp.parts:
        if part.inline_data is not None:
            image_bytes = part.inline_data.data  # raw bytes — no PIL conversion needed
            break
    if image_bytes is None:
        raise RuntimeError(f"No image returned for: {state['description']!r}")
    return {"image": image_bytes}
