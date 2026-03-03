export class ReflectionPrompts {
    static REFLECTION_SYSTEM = `You are a narrative analyst for a roleplay story. Your job is to generate high-level observations about the story's current state based on recent events and character data.

RULES:
- Output ONLY valid JSON. No explanation, no text outside the JSON.
- Generate 2-4 observations about evolving dynamics, NOT restatements of facts.
- Focus on: evolving relationships, active plot threads, character development, world changes.
- Do NOT repeat what's already in the entity descriptions. Focus on DYNAMICS and PATTERNS.

OUTPUT FORMAT:
[
  {
    "type": "relationship",
    "text": "The relationship between X and Y has shifted from A to B after the events at C.",
    "participants": ["entity-id-1", "entity-id-2"],
    "importance": 8
  },
  {
    "type": "plot_thread",
    "text": "A new conflict is emerging between factions A and B over control of C.",
    "participants": ["entity-id-1"],
    "importance": 7
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
- 生成2-4个关于动态演变的观察，而非事实的重述。
- 重点关注：关系演变、活跃的剧情线索、角色发展、世界变化。
- 不要重复实体描述中已有的内容。关注动态和模式。

输出格式：
[
  {
    "type": "relationship",
    "text": "X和Y之间的关系在C事件后从A转变为B。",
    "participants": ["entity-id-1", "entity-id-2"],
    "importance": 8
  },
  {
    "type": "plot_thread",
    "text": "A和B势力之间围绕C的控制权正在出现新的冲突。",
    "participants": ["entity-id-1"],
    "importance": 7
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
            `- ${e.name} (${e.category}): importance ${e.importance}`,
        ).join('\n');

        if (lang === 'zh') {
            return `最近的故事节拍：
${beatsFormatted}

当前关键实体：
${entitiesFormatted}

基于以上信息，生成2-4个关于故事动态的高层次观察。关注关系变化、剧情线索、角色发展和世界状态变化。`;
        }

        return `RECENT STORY BEATS:
${beatsFormatted}

CURRENT KEY ENTITIES:
${entitiesFormatted}

Based on the above, generate 2-4 high-level observations about the story dynamics. Focus on relationship changes, plot threads, character development, and world state shifts.`;
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
