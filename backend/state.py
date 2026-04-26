import operator
from typing import Annotated, TypedDict


class PhotoState(TypedDict):
    description: str
    input_images: list[bytes]
    styles: list[str]
    lighting: str
    framing: str
    mood: str
    aspect_ratio: str
    refined_prompt: str
    image: bytes | None


class ShootState(TypedDict):
    photos_in: list[dict]
    styles: list[str]
    lighting: str
    framing: str
    mood: str
    aspect_ratio: str
    results: Annotated[list[dict], operator.add]
