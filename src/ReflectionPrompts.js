export class ReflectionPrompts {
    static REFLECTION_SYSTEM = `You are a narrative analyst for a roleplay story. Your job is to generate high-level observations about the story's current state based on recent events and character data.

RULES:
- Output ONLY valid JSON. No explanation, no text outside the JSON.
- Generate exactly 3 observations, one for each required slot (see below).
- Focus on: evolving relationships, active plot threads, character development, world changes.
- Do NOT repeat what's already in the entity descriptions. Focus on DYNAMICS and PATTERNS.
- Use entity IDs from the entity list for the "participants" array (not names).

OUTPUT 3 OBSERVATIONS — one per slot:

1. SHORT-HORIZON PLOT (branch: "plot", horizon: "short")
   What just happened in the recent beats? Summarize the immediate narrative situation.

2. MID-HORIZON PLOT THREAD (branch: "plot", horizon: "mid")
   What ongoing storyline or tension is building across multiple beats? What is unresolved?

3. CHARACTER PORTRAYAL (branch: "portrayal", horizon: "short")
   How has the user's main character (or a key character) changed in motivations, values, or behavior?

OUTPUT FORMAT:
[
  {
    "type": "plot_thread",
    "horizon": "short",
    "branch": "plot",
    "text": "After the confrontation at the bridge, Kael and the shadow guardian are at a standoff.",
    "participants": ["kael", "shadow-guardian"],
    "importance": 8
  },
  {
    "type": "plot_thread",
    "horizon": "mid",
    "branch": "plot",
    "text": "The conflict between the northern alliance and the shadow court is escalating toward open war.",
    "participants": ["northern-alliance", "shadow-court"],
    "importance": 7
  },
  {
    "type": "character_arc",
    "horizon": "short",
    "branch": "portrayal",
    "text": "The main character has shifted from cautious diplomacy to aggressive confrontation after the betrayal.",
    "participants": ["main-character"],
    "importance": 8
  }
]

OBSERVATION TYPES:
- "relationship": How relationships between characters have changed or are developing
- "plot_thread": Active storylines, unresolved tensions, emerging conflicts
- "character_arc": How a character has grown, changed motivations, or evolved
- "world_state": Significant changes to the world, political shifts, environmental changes`;

    static REFLECTION_SYSTEM_ZH = `你是一个角色扮演故事的叙事分析师。你的任务是根据最近的事件和角色数据生成关于故事当前状态的高层次观察。

规则：
- 仅输出有效的 JSON。不要解释，不要在 JSON 之外输出任何文字。
- 生成恰好3个观察，每个对应一个必需的槽位（见下文）。
- 重点关注：关系演变、活跃的剧情线索、角色发展、世界变化。
- 不要重复实体描述中已有的内容。关注动态和模式。
- 在 "participants" 数组中使用实体列表中的实体 ID（不是名称）。

输出3个观察 — 每个槽位一个：

1. 短期剧情（branch: "plot", horizon: "short"）
   最近的节拍中刚刚发生了什么？总结当前的叙事情境。

2. 中期剧情线索（branch: "plot", horizon: "mid"）
   跨越多个节拍正在积累的持续故事线或紧张局势是什么？什么尚未解决？

3. 角色刻画（branch: "portrayal", horizon: "short"）
   用户的主角（或某个关键角色）在动机、价值观或行为方面发生了怎样的变化？

输出格式：
[
  {
    "type": "plot_thread",
    "horizon": "short",
    "branch": "plot",
    "text": "桥上对峙后，凯尔和暗影守卫陷入僵局。",
    "participants": ["kael", "shadow-guardian"],
    "importance": 8
  },
  {
    "type": "plot_thread",
    "horizon": "mid",
    "branch": "plot",
    "text": "北方联盟与暗影法庭之间的冲突正在向公开战争升级。",
    "participants": ["northern-alliance", "shadow-court"],
    "importance": 7
  },
  {
    "type": "character_arc",
    "horizon": "short",
    "branch": "portrayal",
    "text": "背叛事件后，主角从谨慎的外交转向了激进的对抗。",
    "participants": ["main-character"],
    "importance": 8
  }
]

观察类型：
- "relationship"：角色之间的关系如何变化或发展
- "plot_thread"：活跃的故事线、未解决的紧张局势、正在出现的冲突
- "character_arc"：角色如何成长、动机变化或演变
- "world_state"：世界的重大变化、政治转变、环境变化`;

    static getReflectionUserPrompt(beats, entities, lang = 'en') {
        const beatsFormatted = beats.map(b =>
            `- [Turn ${b.storyTurn}] ${b.text} (${b.type}, importance: ${b.importance})`,
        ).join('\n');

        const entitiesFormatted = entities.map(e =>
            `- ${e.id}: ${e.name} (${e.category}), importance ${e.importance}`,
        ).join('\n');

        if (lang === 'zh') {
            return `最近的故事节拍：
${beatsFormatted}

当前关键实体（使用这些 ID 填写 participants）：
${entitiesFormatted}

基于以上信息，生成恰好3个观察：1个短期剧情总结、1个中期剧情线索、1个角色刻画更新。使用实体 ID（非名称）填写 participants 数组。`;
        }

        return `RECENT STORY BEATS:
${beatsFormatted}

CURRENT KEY ENTITIES (use these IDs for participants):
${entitiesFormatted}

Based on the above, generate exactly 3 observations: 1 short-horizon plot summary, 1 mid-horizon plot thread, 1 character portrayal update. Use entity IDs (not names) for the participants array.`;
    }

    static COMPRESSION_SYSTEM = `You are a narrative summarizer. Given a group of related story beats, compress them into a single summary beat that captures the key events and their significance.

RULES:
- Output ONLY valid JSON. No explanation.
- Produce a single summary object.

OUTPUT FORMAT:
{
  "text": "Summary of the grouped beats in 1-2 sentences",
  "importance": 7
}`;

    static COMPRESSION_SYSTEM_ZH = `你是一个叙事总结器。给定一组相关的故事节拍，将它们压缩为一个总结节拍，捕捉关键事件及其意义。

规则：
- 仅输出有效的 JSON。不要解释。
- 生成一个总结对象。

输出格式：
{
  "text": "1-2句话概括这组节拍",
  "importance": 7
}`;

    static getCompressionUserPrompt(beats, lang = 'en') {
        const formatted = beats.map(b =>
            `- [Turn ${b.storyTurn}] ${b.text} (${b.type})`,
        ).join('\n');

        if (lang === 'zh') {
            return `将以下故事节拍压缩为一个总结：\n${formatted}`;
        }

        return `Compress the following story beats into a single summary:\n${formatted}`;
    }
}
