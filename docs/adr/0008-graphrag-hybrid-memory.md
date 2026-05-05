# ADR-0008: GraphRAG Hybrid Memory Architecture

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** SCAAI Core Team
**Technical Story:** Enhancement for relational memory and structured knowledge extraction.

## Context

SCAAI originally relied on ChromaDB (vector database) for semantic RAG. While effective for similarity-based retrieval, vector search struggles with:
1. **Relational Reasoning**: Answering questions like "What are all projects related to User X?" requires explicit edges, which are fuzzy in vector space.
2. **Multi-hop Queries**: Connecting disjoint pieces of information through a chain of entities.
3. **Structured Awareness**: The system lacks a discrete "map" of what it knows about the world.

We needed a way to store explicit entity-relationship triples without abandoning the semantic power of ChromaDB.

## Decision

We implemented a **Hybrid Memory System**:
1. **ChromaDB**: Continues to handle unstructured semantic storage (chunks of text).
2. **SQLite (Knowledge Graph)**: A new relational layer stores entities and edges in a `knowledge_graph.db`.
3. **Autonomous Extraction**: The `reflectionEngine.js` was upgraded to perform "Triple Extraction" (Subject-Predicate-Object) during the inner monologue phase.
4. **Graph Visualization**: A new UI tab using `vis-network` provides a visual graph explorer for the user.

## Consequences

### Positive
- **Structured Retrieval**: The model can now perform exact relational queries via SQLite.
- **Improved Grounding**: Memory telemetry (counts of nodes/edges) gives the LLM high-level awareness of its "knowledge density."
- **Visual Insights**: Users gain transparency into what the AI has learned and how entities are connected.

### Negative
- **Extraction Overhead**: The reflection loop now consumes more tokens/time to perform extraction.
- **Schema Management**: We now have two separate memory schemas to maintain and keep synchronized.

### Neutral
- **SQLite Dependency**: Adds a lightweight SQL engine dependency (via `semantic_bridge.py`), but remains local-first.

## Alternatives Considered

### Alternative 1: Vector-Only Graph (Vector DB + Metadata)
**Description:** Storing relationships as metadata in ChromaDB.
**Pros:** Single database, lower complexity.
**Cons:** Very poor performance for multi-hop queries; no native graph traversal capabilities.

### Alternative 2: Neo4j / External Graph DB
**Description:** Using a dedicated graph database.
**Pros:** Extremely powerful graph queries.
**Cons:** High setup overhead, not suitable for a "portable" local-first desktop application.

## References
- [graph-memory-engine.md](file:///c:/Users/HP/OneDrive/Desktop/Agentic/SCAAI_RUN/docs/systems/graph-memory-engine.md)
- [Reflection Engine Docs](file:///c:/Users/HP/OneDrive/Desktop/Agentic/SCAAI_RUN/docs/systems/reflective-loop.md)
