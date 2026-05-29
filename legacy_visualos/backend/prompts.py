from .config import get_option_description
from .state import PhotoshootState


def _setting_line(label: str, category: str, value: str | None) -> str:
    return f"- {label}: {get_option_description(category, value)}"


def build_reference_mapping(state: PhotoshootState) -> str:
    references = state.get("reference_images", [])
    if not references:
        return "No uploaded reference images."

    lines = ["Reference image mapping. Use these exact names when reasoning:"]
    for index, ref in enumerate(references, start=1):
        role = ref.get("role", "reference")
        name = ref["name"]
        path = ref["path"]
        lines.append(f"- Uploaded image {index}: ({name}), role: {role}, source: {path}")
    return "\n".join(lines)


def build_refine_messages(state: PhotoshootState) -> tuple[str, str]:
    reference_mapping = state.get("reference_mapping") or build_reference_mapping(state)
    engine_params = state.get("engine_params") or {}

    system_prompt = """You are a senior fashion and product photography art director.
Rewrite the user's prompt into one highly detailed image-generation prompt for Gemini.

You must preserve the user's creative intent, but make it more concrete, photographic,
and controllable. Integrate the provided image settings naturally. If reference images
are provided, explicitly use their names in parentheses, such as (model) or (product1),
and describe the role of each named reference clearly.

The final prompt must be a single production-ready paragraph. Do not include bullets,
preamble, commentary, JSON, markdown, or quotation marks."""

    user_prompt = f"""Initial user prompt:
{state["initial_prompt"]}

{reference_mapping}

Chosen image settings:
{_setting_line("Style / Genre", "style_genre", state.get("style_genre"))}
{_setting_line("Moodboard / Grading", "moodboard_grading", state.get("moodboard_grading"))}
{_setting_line("Framing", "framing", state.get("framing"))}
{_setting_line("Camera Angle", "camera_angle", state.get("camera_angle"))}
{_setting_line("Lens / Focal Length", "lens_focal_length", state.get("lens_focal_length"))}
{_setting_line("Lighting Setup", "lighting_setup", state.get("lighting_setup"))}
{_setting_line("Environment / Setting", "environment_setting", state.get("environment_setting"))}
- Aspect ratio: {state.get("aspect_ratio", "1:1")}
- Output size: {state.get("size", "1K")}
- Engine parameters: {engine_params}

Refinement requirements:
- If product references are provided, preserve their visible identity, materials, silhouette, and key design details.
- If model references are provided, use them for subject identity, pose, styling, or body-language only as instructed by the user's prompt.
- If the user names references in parentheses, keep those exact names in the refined prompt.
- Mention lens feel, composition, depth of field, lighting direction, texture, environment, and color grading.
- Avoid extra logos, watermarks, malformed limbs, duplicated products, unreadable text, and inconsistent scale."""

    return system_prompt, user_prompt
