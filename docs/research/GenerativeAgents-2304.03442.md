# Generative Agents: Interactive Simulacra of Human Behavior

**arXiv:** 2304.03442 (April 2023)
**Authors:** Joon Sung Park, Joseph C. O'Brien, Carrie J. Cai, Meredith Ringel Morris, Percy Liang, Michael S. Bernstein
**Affiliation:** Stanford University / Google DeepMind
**Venue:** UIST 2023

## Core Problem
Creating believable, persistent, autonomous agents that simulate human behavior over extended periods. Prior approaches (hand-crafted rules, FSMs) couldn't capture open-ended richness of human behavior.

## Architecture: Three-Component Agent System

### 1. Memory Stream (Observation & Storage)
- Comprehensive, append-only log of experiences in natural language
- Each memory object: description, creation timestamp, last-access timestamp
- Complete experiential record — nothing discarded

### 2. Retrieval Function (Tri-Score Ranking)
Three factors combined into a single weighted score:
- **Recency:** Exponential decay on time since last access
- **Importance:** 1-10 score assigned at creation by LLM (mundane=low, pivotal=high)
- **Relevance:** Cosine similarity between query embedding and memory embedding

Scores normalized and weighted-summed. Top-ranked memories passed to LLM context.

### 3. Reflection (Higher-Level Abstraction)
- Triggered when cumulative importance of recent observations crosses threshold
- Agent asks: "What are the 3 most salient high-level questions I can answer?"
- Retrieves relevant memories per question → synthesizes insights
- Reflections stored back into memory stream as first-class objects
- Enables **recursive abstraction** (reflections on reflections)
- Critical for coherent self-concept and social understanding over time

### 4. Planning and Reacting
- Daily plans generated each morning, recursively decomposed (day → hour → 5-15min)
- Plans revisable mid-stream based on new observations
- Encounter reactions: consider context, relationship, retrieved memories → decide

## Environment: Smallville
- 25 agents in Sims-inspired sandbox
- Each initialized with ~1 paragraph seed description
- Two simulated days of autonomous behavior

## Key Results

### Emergent Behaviors
- **Information diffusion:** Valentine's Day party idea spread through social network
- **Relationship formation:** Agents formed new acquaintances, developed opinions
- **Coordination:** Agents coordinated party arrival times without scripting
- **Memory consistency:** Agents recalled past conversations accurately

### Ablation Study (Critical!)
| Condition | Believability |
|-----------|--------------|
| Full architecture | **Highest** |
| No reflection | Significant drop — shallow, less coherent |
| No planning | Reactive but lacked purposeful routines |
| No memory retrieval | **Worst** — confabulated, contradicted, forgot |

**All three components matter. Reflection especially critical for long-term coherence.**

### Failure Modes
- Embellishment/hallucination of memories
- Retrieval errors → non-sequiturs
- Overly cooperative behavior (RLHF bias)
- Inconsistencies accumulate over very long time horizons
- High API cost

## Key Takeaways for rp-memory
1. **Tri-score retrieval (recency + importance + relevance)** is the gold standard — directly applicable
2. **Reflection/consolidation** is essential for long-term character coherence
3. **Importance scoring at creation time** enables efficient long-term memory management
4. **Append-only memory stream** prevents information loss
5. **Recursive abstraction** (reflections on reflections) enables multi-scale understanding
6. **All three mechanisms (memory, reflection, planning) required** — removing any one significantly degrades believability
