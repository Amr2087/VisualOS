from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from .nodes import generate_image_node, refine_prompt_node
from .state import PhotoState, ShootState


def _build_photo_subgraph():
    g = StateGraph(PhotoState)
    g.add_node("refine_prompt", refine_prompt_node)
    g.add_node("generate_image", generate_image_node)
    g.add_edge(START, "refine_prompt")
    g.add_edge("refine_prompt", "generate_image")
    g.add_edge("generate_image", END)
    return g.compile()


_photo_subgraph = _build_photo_subgraph()


def _process_photo(state: PhotoState) -> dict:
    result = _photo_subgraph.invoke(dict(state))
    return {"results": [result]}


def _dispatch(state: ShootState) -> list[Send]:
    return [
        Send(
            "process_photo",
            {
                "description": p["description"],
                "input_images": p.get("input_images", []),
                "styles": state["styles"],
                "lighting": state["lighting"],
                "framing": state["framing"],
                "mood": state["mood"],
                "aspect_ratio": state["aspect_ratio"],
                "refined_prompt": "",
                "image": None,
            },
        )
        for p in state["photos_in"]
    ]


def build_graph():
    g = StateGraph(ShootState)
    g.add_node("process_photo", _process_photo)
    g.add_conditional_edges(START, _dispatch, ["process_photo"])
    g.add_edge("process_photo", END)
    return g.compile()
