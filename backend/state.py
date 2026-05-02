from typing import Any, TypedDict


class ReferenceImage(TypedDict):
    name: str
    role: str
    path: str
    mime_type: str
    data: bytes


class PhotoshootState(TypedDict, total=False):
    initial_prompt: str
    products_img_paths: list[str]
    model_img_paths: list[str]
    reference_images: list[ReferenceImage]
    reference_mapping: str

    style_genre: str
    moodboard_grading: str
    framing: str
    camera_angle: str
    lens_focal_length: str
    lighting_setup: str
    environment_setting: str
    engine_params: dict[str, Any]
    size: str
    aspect_ratio: str

    refined_prompt: str
    output_image: bytes | None
    output_mime_type: str
