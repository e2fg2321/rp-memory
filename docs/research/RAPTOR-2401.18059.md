# RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval

**arXiv:** 2401.18059 (January 2024)
**Authors:** Parth Sarthi, Salman Abdullah, Aditi Tuli, Shubh Khanna, Anna Goldie, Christopher D. Manning
**Affiliation:** Stanford University

## Core Problem
Traditional RAG retrieves short, contiguous text chunks from flat indexes. This limits:
1. Multi-step reasoning (info scattered across document)
2. Thematic/high-level understanding
3. Variable granularity (some queries need detail, others need overview)

## Architecture: Hierarchical Summary Tree

### Tree Construction (Bottom-Up, Recursive)
1. **Chunking:** Split source text into ~100-token chunks (sentence boundaries)
2. **Embedding:** Embed every chunk with SBERT
3. **Clustering:** Group via **Gaussian Mixture Models (GMMs)** with **soft clustering**
   - Dimensionality reduction via UMAP before clustering
   - Optimal clusters selected via Bayesian Information Criterion (BIC)
   - A chunk can belong to MULTIPLE clusters (soft assignment)
4. **Summarization:** Each cluster summarized by LLM → parent node
5. **Recurse:** Re-embed parents, cluster again, summarize again → build tree upward

**Critical design choice:** Semantic clustering, NOT positional adjacency. Passages from distant parts of a document discussing the same topic are grouped together.

### Tree Structure
- **Leaf nodes:** Original ~100-token chunks (fine-grained detail)
- **Intermediate nodes:** Summaries of semantically related groups
- **Root nodes:** Highest-level thematic summaries
- ~72% compression ratio per level

### Querying: Collapsed Tree (Preferred)
- Flatten entire tree into single layer
- Retrieve top nodes by cosine similarity until token budget reached (2000 tokens)
- Freely mixes nodes from any level → adapts granularity to question
- Outperforms tree-traversal (layer-by-layer top-down) approach

## Key Results

### With GPT-4 as reader (State-of-Art)
| Benchmark | RAPTOR + GPT-4 | Previous SOTA | Delta |
|-----------|----------------|---------------|-------|
| QuALITY | **82.6%** | 62.3% | +20.3% |
| QuALITY-HARD | **76.2%** | 54.7% | +21.5% |
| QASPER | **55.7%** | 53.9% | +1.8% |

### Layer Contribution
- 18.5-57% of retrieved nodes came from non-leaf (summary) layers
- Confirms hierarchical structure is actively used, not redundant

### Properties
- Linear scaling in token cost and build time with document length
- ~4% hallucination rate in summaries (minor, didn't affect downstream QA)

## Key Takeaways for rp-memory
1. **Semantic clustering >> positional adjacency** for organizing long-form content
2. **Multi-granularity retrieval** is powerful — auto-adapts to query complexity
3. **Collapsed tree** (flat search across all levels) outperforms structured traversal
4. **Soft clustering** (items in multiple groups) prevents info loss at boundaries
5. **Hierarchical summarization** enables efficient compression without losing access to detail
6. **Limitation for live systems:** Tree built offline/batch — incremental variant needed for streaming conversations
7. **4% hallucination rate** in summaries could compound in continuously re-summarized memory systems
