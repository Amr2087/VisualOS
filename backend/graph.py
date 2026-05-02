from langgraph.graph import END, START, StateGraph

from .nodes import generate_image_node, prepare_references_node, refine_prompt_node
from .state import PhotoshootState


def build_graph():
    graph = StateGraph(PhotoshootState)
    graph.add_node("prepare_references", prepare_references_node)
    graph.add_node("refine_prompt", refine_prompt_node)
    graph.add_node("generate_image", generate_image_node)

    graph.add_edge(START, "prepare_references")
    graph.add_edge("prepare_references", "refine_prompt")
    graph.add_edge("refine_prompt", "generate_image")
    graph.add_edge("generate_image", END)

    return graph.compile()
