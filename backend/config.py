import json
from functools import lru_cache
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parent
STYLE_CONFIG_PATH = BACKEND_DIR / "style_config.json"


@lru_cache(maxsize=1)
def load_style_config() -> dict[str, Any]:
    return json.loads(STYLE_CONFIG_PATH.read_text(encoding="utf-8"))


def get_option_description(category: str, option_key: str | None) -> str:
    if not option_key:
        return "Auto"

    config = load_style_config().get("photoshootConfig", {})
    category_config = config.get(category, {})
    option = category_config.get("options", {}).get(option_key)
    if not option:
        return option_key

    label = option.get("label", option_key)
    subtitle = option.get("subtitle")
    description = option.get("description")
    parts = [label]
    if subtitle:
        parts.append(subtitle)
    if description:
        parts.append(description)
    return " - ".join(parts)
