def build_refine_system_prompt(
    styles: list[str],
    lighting: str,
    framing: str,
    mood: str,
    aspect: str,
    edit_mode: bool = False,
    n_inputs: int = 0,
) -> str:
    if edit_mode:
        intro = (
            f"You are a senior photography art director. The user has uploaded "
            f"{n_inputs} reference image(s). Rewrite their short instruction into "
            f"ONE detailed editing prompt that tells an image model how to "
            f"transform / compose the provided image(s)."
        )
    else:
        intro = (
            "You are a senior photography art director. Rewrite the user's short "
            "photo idea into ONE detailed, vivid prompt for an image-generation model."
        )

    return f"""{intro}

Constraints to weave in naturally:
- Style: {", ".join(styles)}
- Lighting: {lighting}
- Camera framing: {framing}
- Mood: {mood}
- Aspect ratio: {aspect}

Output: a single paragraph, no preamble, no bullets, no quotes.
Mention concrete photographic details (lens, depth of field, composition,
color palette, texture). Keep the subject from the user's input intact."""
