from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
import streamlit as st

load_dotenv()

from backend.graph import build_graph  # noqa: E402 — after load_dotenv

# ── constants ──────────────────────────────────────────────────────────────
STYLES = [
    ("editorial", "Editorial / Fashion"),
    ("portrait", "Portrait / Headshot"),
    ("product", "Product / E-commerce"),
    ("lifestyle", "Lifestyle / Cinematic"),
]
LIGHTING = [
    ("natural", "Natural"),
    ("studio", "Studio"),
    ("golden_hour", "Golden Hour"),
    ("dramatic", "Dramatic"),
]
FRAMING = [
    ("close_up", "Close-up"),
    ("medium", "Medium Shot"),
    ("full_body", "Full Body"),
    ("wide", "Wide Shot"),
]
MOOD = [
    ("professional", "Professional"),
    ("playful", "Playful"),
    ("moody", "Moody"),
    ("energetic", "Energetic"),
]
ASPECT = [
    ("1:1", "1:1 Square"),
    ("4:5", "4:5 Portrait"),
    ("9:16", "9:16 Stories"),
    ("16:9", "16:9 Landscape"),
]

OUTPUTS = Path(__file__).parent / "backend" / "outputs"


def _slugify(text: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in text.lower()).strip("-")[:40]


def _save_photo(image_bytes: bytes, refined_prompt: str, description: str) -> Path:
    OUTPUTS.mkdir(exist_ok=True)
    stem = f"{datetime.now():%Y%m%d-%H%M%S}-{_slugify(description)}"
    img_path = OUTPUTS / f"{stem}.png"
    img_path.write_bytes(image_bytes)
    (OUTPUTS / f"{stem}.txt").write_text(refined_prompt, encoding="utf-8")
    return img_path


# ── page config ────────────────────────────────────────────────────────────
st.set_page_config(page_title="VisualOS", page_icon="📸", layout="wide")
st.title("VisualOS")
st.caption("AI photoshoot generator")

# ── session state defaults ─────────────────────────────────────────────────
if "num_photos" not in st.session_state:
    st.session_state.num_photos = 1
if "results" not in st.session_state:
    st.session_state.results = []
if "saved" not in st.session_state:
    st.session_state.saved = set()   # set of result indices already saved

# ── tabs ───────────────────────────────────────────────────────────────────
create_tab, library_tab = st.tabs(["✦ Create", "🗂 Library"])

# ══════════════════════════════════════════════════════════════════════════
# CREATE TAB
# ══════════════════════════════════════════════════════════════════════════
with create_tab:

    # ── shoot controls ──────────────────────────────────────────────────
    st.subheader("Shoot settings")

    selected_styles = st.multiselect(
        "Style",
        options=[v for v, _ in STYLES],
        format_func=lambda v: dict(STYLES)[v],
        default=["editorial"],
    )

    c1, c2, c3, c4 = st.columns(4)
    with c1:
        lighting = st.selectbox(
            "Lighting",
            options=[v for v, _ in LIGHTING],
            format_func=lambda v: dict(LIGHTING)[v],
        )
    with c2:
        framing = st.selectbox(
            "Framing",
            options=[v for v, _ in FRAMING],
            format_func=lambda v: dict(FRAMING)[v],
        )
    with c3:
        mood = st.selectbox(
            "Mood",
            options=[v for v, _ in MOOD],
            format_func=lambda v: dict(MOOD)[v],
        )
    with c4:
        aspect_ratio = st.selectbox(
            "Aspect ratio",
            options=[v for v, _ in ASPECT],
            format_func=lambda v: dict(ASPECT)[v],
        )

    st.divider()

    # ── photo cards ─────────────────────────────────────────────────────
    st.subheader("Photos")

    add_col, rem_col = st.columns([1, 1])
    with add_col:
        if st.button("＋ Add photo", use_container_width=True):
            st.session_state.num_photos += 1
            st.rerun()
    with rem_col:
        if st.button(
            "－ Remove last",
            use_container_width=True,
            disabled=st.session_state.num_photos <= 1,
        ):
            st.session_state.num_photos -= 1
            st.rerun()

    photos_data: list[dict] = []
    for i in range(st.session_state.num_photos):
        with st.expander(f"Shot {i + 1}", expanded=True):
            desc = st.text_area(
                "Description",
                key=f"desc_{i}",
                placeholder="Describe this photo…",
                height=80,
                label_visibility="collapsed",
            )
            uploaded = st.file_uploader(
                "Reference images (optional — enables edit/compose mode)",
                key=f"files_{i}",
                accept_multiple_files=True,
                type=["png", "jpg", "jpeg", "webp"],
            )
            input_images = [f.read() for f in (uploaded or [])]
            if input_images:
                st.caption(f"✓ {len(input_images)} reference image(s) attached — edit mode")
            photos_data.append({"description": desc, "input_images": input_images})

    st.divider()

    # ── generate button ─────────────────────────────────────────────────
    if st.button("Generate shoot", type="primary", use_container_width=True):
        if not selected_styles:
            st.error("Please select at least one style.")
        elif any(not p["description"].strip() for p in photos_data):
            st.error("Please add a description for every shot.")
        else:
            with st.spinner(f"Generating {len(photos_data)} shot(s)…"):
                graph = build_graph()
                final = graph.invoke(
                    {
                        "photos_in": photos_data,
                        "styles": selected_styles,
                        "lighting": lighting,
                        "framing": framing,
                        "mood": mood,
                        "aspect_ratio": aspect_ratio,
                        "results": [],
                    }
                )
            st.session_state.results = final["results"]
            st.session_state.saved = set()
            st.rerun()

    # ── results ─────────────────────────────────────────────────────────
    if st.session_state.results:
        st.subheader("Results")
        for idx, photo in enumerate(st.session_state.results):
            st.markdown(f"**Shot {idx + 1}** — {photo.get('description', '')}")

            if photo.get("refined_prompt"):
                with st.expander("Refined prompt"):
                    st.write(photo["refined_prompt"])

            if photo.get("image"):
                st.image(photo["image"], use_container_width=True)

                dl_col, save_col = st.columns(2)
                with dl_col:
                    st.download_button(
                        "⬇ Download",
                        data=photo["image"],
                        file_name=f"shot-{idx + 1}.png",
                        mime="image/png",
                        key=f"dl_{idx}",
                        use_container_width=True,
                    )
                with save_col:
                    if idx in st.session_state.saved:
                        st.button(
                            "✓ Saved",
                            key=f"save_{idx}",
                            disabled=True,
                            use_container_width=True,
                        )
                    else:
                        if st.button("💾 Save", key=f"save_{idx}", use_container_width=True):
                            _save_photo(
                                photo["image"],
                                photo.get("refined_prompt", ""),
                                photo.get("description", "shot"),
                            )
                            st.session_state.saved.add(idx)
                            st.rerun()
            else:
                st.warning(f"Shot {idx + 1}: no image returned.")

            st.divider()

# ══════════════════════════════════════════════════════════════════════════
# LIBRARY TAB
# ══════════════════════════════════════════════════════════════════════════
with library_tab:
    if st.button("↺ Refresh", key="lib_refresh"):
        st.rerun()

    pngs = sorted(OUTPUTS.glob("*.png"), reverse=True) if OUTPUTS.exists() else []

    if not pngs:
        st.info("No saved images yet. Generate and save photos to see them here.")
    else:
        st.caption(f"{len(pngs)} saved shot(s)")
        cols = st.columns(3)
        for i, png in enumerate(pngs):
            with cols[i % 3]:
                st.image(str(png), use_container_width=True)
                st.caption(
                    datetime.fromtimestamp(png.stat().st_mtime).strftime(
                        "%Y-%m-%d %H:%M"
                    )
                )
                txt = png.with_suffix(".txt")
                if txt.exists():
                    prompt_text = txt.read_text(encoding="utf-8")
                    with st.expander("Prompt"):
                        st.write(prompt_text)
