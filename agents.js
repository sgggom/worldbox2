import { callOpenAiCompatible, estimateTokens, parseJsonPayload } from "./llm.js";

const SETUP_FIELDS = [
  {
    key: "world",
    label: "世界舞台与时代背景",
    required: true,
    guidance: "只确认故事发生在什么世界、时代和权力结构里。",
  },
  {
    key: "genre",
    label: "核心冲突或剧情类型",
    required: true,
    guidance: "只确认玩家最想体验哪类冲突、推进方式和主线张力。",
  },
  {
    key: "protagonist",
    label: "主角身份与起始立场",
    required: true,
    guidance: "只确认玩家想以什么身份、立场和处境进入故事。",
  },
  {
    key: "tone",
    label: "整体氛围与节奏",
    required: true,
    guidance: "只确认整体气质、情绪浓度和叙事节奏。",
  },
  {
    key: "boundaries",
    label: "禁忌与边界",
    required: false,
    guidance: "只确认玩家不想出现的内容、强度或叙事边界。",
  },
];

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeChoices(choices = []) {
  return choices
    .filter(Boolean)
    .slice(0, 4)
    .map((choice, index) => ({
      id: choice.id || `choice-${index + 1}`,
      label: choice.label || choice.title || choice.text || `选项 ${index + 1}`,
      intent: choice.intent || "",
      payload: choice.payload || choice.label || choice.text || "",
    }));
}

function createTurnRecord(summary, payload) {
  return {
    summary,
    payload,
    at: nowIso(),
  };
}

function remember(memory, summary, payload) {
  memory.recentTurns = [...memory.recentTurns, createTurnRecord(summary, payload)].slice(-5);
}

function compressIfNeeded(memory, budget) {
  const tokenEstimate =
    estimateTokens(memory.canonSummary) +
    estimateTokens(memory.chapterSummary) +
    estimateTokens(memory.recentTurns);

  if (tokenEstimate < budget * 0.7) {
    return;
  }

  const older = memory.recentTurns.slice(0, -2);
  if (!older.length) {
    return;
  }

  const merged = older
    .map((item) => item.summary)
    .filter(Boolean)
    .join(" / ");

  memory.chapterSummary = [memory.chapterSummary, merged]
    .filter(Boolean)
    .join(" | ")
    .slice(-1800);
  memory.recentTurns = memory.recentTurns.slice(-2);
  memory.compressions += 1;
  memory.lastCompressedAt = nowIso();
}

function updateCanon(memory, summary) {
  if (!summary) {
    return;
  }
  memory.canonSummary = summary.slice(0, 1600);
}

function baseMessages(rolePrompt, userPrompt) {
  return [
    { role: "system", content: rolePrompt },
    { role: "user", content: userPrompt },
  ];
}

async function callStructuredAgent({
  agentId,
  config,
  memory,
  rolePrompt,
  userPrompt,
  requestOptions,
  mock,
}) {
  if (config.providerPreset === "mock") {
    const payload = await mock();
    remember(memory, payload.summary || `${agentId} completed`, payload);
    compressIfNeeded(memory, config.maxContextBudget);
    return payload;
  }

  const resolvedOptions = requestOptions || getRequestOptionsForAgent(agentId);
  try {
    const raw = await callOpenAiCompatible(
      config,
      baseMessages(rolePrompt, userPrompt),
      resolvedOptions
    );
    const payload = await parseStructuredPayloadWithRepair({
      agentId,
      config,
      rolePrompt,
      userPrompt,
      raw,
      requestOptions: resolvedOptions,
    });
    remember(memory, payload.summary || `${agentId} completed`, payload);
    compressIfNeeded(memory, config.maxContextBudget);
    return payload;
  } catch (error) {
    if (shouldUseLocalStructuredFallback(error, mock)) {
      const fallbackPayload = await mock();
      fallbackPayload.__fallbackMeta = {
        agentId,
        source: "mock",
        reason: error.message,
      };
      remember(memory, fallbackPayload.summary || `${agentId} completed`, fallbackPayload);
      compressIfNeeded(memory, config.maxContextBudget);
      return fallbackPayload;
    }
    throw new Error(`${agentId} 失败：${error.message}`);
  }
}

async function parseStructuredPayloadWithRepair({
  agentId,
  config,
  rolePrompt,
  userPrompt,
  raw,
  requestOptions,
}) {
  try {
    return parseJsonPayload(raw);
  } catch (parseError) {
    let repairFailureMessage = "模型原始输出未能自动修复为合法 JSON。";
    let repairedRaw = "";

    try {
      repairedRaw = await callOpenAiCompatible(
        config,
        buildJsonRepairMessages(agentId, rolePrompt, userPrompt, raw),
        {
          maxTokens: Math.max(260, Math.min(requestOptions?.maxTokens || 700, 900)),
          timeoutMs: Math.min(requestOptions?.timeoutMs || 60000, 45000),
        }
      );
    } catch (repairCallError) {
      repairFailureMessage = `JSON 修复请求失败：${repairCallError.message}`;
    }

    if (repairedRaw) {
      try {
        return parseJsonPayload(repairedRaw);
      } catch (_repairError) {
        repairFailureMessage = "模型原始输出未能自动修复为合法 JSON。";
      }
    }

    const error = new Error(`${parseError.message}。${repairFailureMessage}`);
    error.code = "STRUCTURED_OUTPUT_INVALID";
    throw error;
  }
}

function buildJsonRepairMessages(agentId, rolePrompt, userPrompt, rawOutput) {
  return [
    {
      role: "system",
      content:
        "你是 JSON 修复器。把给定内容整理成严格合法的 JSON。只输出 JSON 本体，不要解释，不要 markdown 代码块，不要补充额外文字。",
    },
    {
      role: "user",
      content: `目标 agent：${agentId}

该 agent 的职责：
${rolePrompt}

原始任务中的 JSON 要求：
${extractJsonContract(userPrompt)}

模型原始输出：
${String(rawOutput || "").slice(0, 7000)}

请根据以上要求，输出严格合法的 JSON。`,
    },
  ];
}

function extractJsonContract(prompt) {
  const text = String(prompt || "");
  const marker = text.indexOf("只输出 JSON：");
  if (marker >= 0) {
    return text.slice(marker, marker + 2600);
  }
  return text.slice(-2600);
}

function shouldUseLocalStructuredFallback(error, mock) {
  return typeof mock === "function" && error?.code === "STRUCTURED_OUTPUT_INVALID";
}

function collectSetupAnswers(storyState) {
  const pairs = SETUP_FIELDS.map((field) => {
    const value = storyState.setup.answers[field.key];
    return value ? `${field.label}: ${value}` : null;
  }).filter(Boolean);
  return pairs.join("\n");
}

function getNormalizedAnswer(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasSetupAnswer(storyState, fieldKey) {
  return Boolean(getNormalizedAnswer(storyState.setup.answers[fieldKey]));
}

function getMissingSetupFields(storyState, { includeOptional = false } = {}) {
  return SETUP_FIELDS.filter((field) => (includeOptional || field.required) && !hasSetupAnswer(storyState, field.key));
}

function getNextSetupField(storyState) {
  return getMissingSetupFields(storyState)[0] || null;
}

function buildSetupDigest(storyState) {
  const answers = storyState.setup.answers;
  return [
    `世界舞台是 ${answers.world || "待补全"}。`,
    `核心冲突偏向 ${answers.genre || "待补全"}。`,
    `玩家希望扮演 ${answers.protagonist || "待补全"}。`,
    `整体氛围是 ${answers.tone || "待补全"}。`,
    `内容边界：${answers.boundaries || "未特别限制"}。`,
  ].join(" ");
}

function createDeterministicSeed(...parts) {
  const text = parts.filter(Boolean).join("|") || "seed";
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function rotateTake(list, count, seed) {
  if (!Array.isArray(list) || !list.length) {
    return [];
  }

  const start = ((seed % list.length) + list.length) % list.length;
  const picked = [];
  for (let index = 0; index < Math.min(count, list.length); index += 1) {
    picked.push(list[((start + index) % list.length + list.length) % list.length]);
  }
  return picked;
}

function pickDeterministic(list, seed, offset = 0) {
  if (!Array.isArray(list) || !list.length) {
    return "";
  }
  return list[(Math.abs(seed) + offset) % list.length];
}

function inferWorldFlavor(storyState) {
  const world = storyState.setup.answers.world || "";
  const genre = storyState.setup.answers.genre || "";
  const text = `${world} ${genre}`;

  if (/(宫|后宫|朝堂|王朝|妃|皇|帝|女官)/.test(text)) {
    return "court";
  }
  if (/(赛博|都市|公司|集团|近未来|街区)/.test(text)) {
    return "urban";
  }
  if (/(仙|宗门|奇幻|灵|妖|修真)/.test(text)) {
    return "fantasy";
  }
  return "general";
}

function buildDynamicSetupQuestion(field, storyState) {
  const answers = storyState.setup.answers;
  const seed = createDeterministicSeed(
    "setup-question",
    field.key,
    storyState.storyId,
    storyState.setup.turnCount,
    JSON.stringify(answers)
  );

  switch (field.key) {
    case "world": {
      const openings = [
        "先别套现成模板，直接说你脑海里第一个浮出来的舞台。",
        "我们先抓世界底色，不预设类型，你心里最有画面的舞台是什么？",
        "开局先定世界，不按固定题库走。你想把故事扔进怎样的时代和秩序里？",
        "先把世界感定住。你更想看到怎样的时代气味、权力结构和生存压力？",
      ];
      const focus = [
        "它更像一座礼法森严却处处藏针的宫城，还是某种高压运转的陌生秩序？",
        "你可以从时代、权力中心、社会规则，或者最想看到的生活质感切进去。",
        "不用拘泥于标签，你只要告诉我这个世界最先扑到脸上的那种空气感。",
        "如果玩家一睁眼就站进这个世界，你最想让他先感受到什么秩序和压迫？",
      ];
      return `${pickDeterministic(openings, seed)}${pickDeterministic(focus, seed, 1)}`;
    }
    case "genre": {
      const openings = [
        "舞台定下来之后，我们抓主线冲突。",
        "有了世界以后，接下来该定它最锋利的矛盾。",
        "世界底色已经有轮廓了，现在说说你最想玩的戏核。",
      ];
      const focus = [
        `在这个${answers.world || "世界"}里，你更想让故事围着哪种冲突转？`,
        `放进${answers.world || "这个舞台"}以后，什么样的主线最能勾住你？`,
        `如果把${answers.world || "这个世界"}真正推起来，你希望核心张力落在哪一类对抗上？`,
      ];
      return `${pickDeterministic(openings, seed)}${pickDeterministic(focus, seed, 1)}`;
    }
    case "protagonist": {
      const openings = [
        "接下来定你从哪里入局。",
        "主线有了，现在选主角切口。",
        "轮到确定玩家身份了。",
      ];
      const focus = [
        `在这个${answers.world || "世界"}里，你想以什么身份卷进${answers.genre || "这条主线"}？`,
        `面对${answers.genre || "这类冲突"}，你更想站在什么位置、带着什么起手处境进场？`,
        `如果故事从你第一步落地开始，你更想让主角是局中人、边缘人，还是被迫拖下水的人？`,
      ];
      return `${pickDeterministic(openings, seed)}${pickDeterministic(focus, seed, 2)}`;
    }
    case "tone": {
      const openings = [
        "最后把整体气质拧紧。",
        "再定一下这部互动小说的情绪和速度。",
        "现在只差整体氛围了。",
      ];
      const focus = [
        `如果把这段${answers.genre || "故事"}真正写出来，你更想要它呈现什么气质和节奏？`,
        `落到行文里，你希望它更压抑、锋利、华丽，还是慢慢逼近的悬疑感？`,
        `从阅读体感来说，你更想让它像贴着呼吸推进，还是像钝刀慢慢压下来？`,
      ];
      return `${pickDeterministic(openings, seed)}${pickDeterministic(focus, seed, 1)}`;
    }
    case "boundaries": {
      const openings = [
        "最后补一下边界。",
        "收尾前，把不想碰的内容也定掉。",
        "还差一项安全线设置。",
      ];
      const focus = [
        "有没有你明确不想出现的内容、强度、关系走向或描写方式？",
        "哪些桥段你希望避开，或者至少别写得太重？",
        "如果有禁区，现在说清楚，后面就按这个边界跑。",
      ];
      return `${pickDeterministic(openings, seed)}${pickDeterministic(focus, seed, 2)}`;
    }
    default:
      return `继续补全「${field.label}」的信息。`;
  }
}

function buildDynamicSetupChoices(field, storyState) {
  const seed = createDeterministicSeed(
    field.key,
    storyState.storyId,
    storyState.setup.turnCount,
    JSON.stringify(storyState.setup.answers)
  );
  const flavor = inferWorldFlavor(storyState);
  let candidates = [];

  if (field.key === "world") {
    const eras = [
      "礼法森严的深宫王朝",
      "繁华与猜忌并生的旧都",
      "霓虹失真的近未来城邦",
      "财阀盘踞的高压都市",
      "灵脉将断的修真宗门地界",
      "神权与皇权撕扯的祭祀王庭",
      "海贸改写秩序的群岛联邦",
      "蒸汽与铁律并行的工业帝国",
    ];
    const powerStructures = [
      "朝堂、后宫与家族势力互相咬合",
      "监察机关与商会共同编织日常秩序",
      "旧贵族、军权与地下消息网彼此牵制",
      "宗门戒律、世俗王权与民间力量三方失衡",
      "神殿、皇室和地方豪强同时争夺解释权",
      "公司、安保系统与黑市渠道一起分食权力",
    ];
    const pressures = [
      "表面华丽，暗处每一步都像踩在针尖上",
      "规则看似完整，实际人人都靠试探活着",
      "秩序没有崩，但裂缝已经多到能吞人",
      "人人都在守规矩，人人也都准备破规矩",
      "表面安静，底层却像被慢火一直煨着",
      "空气里总像压着一件随时会爆开的旧事",
    ];

    const eraSlice = rotateTake(eras, 4, seed);
    const powerSlice = rotateTake(powerStructures, 4, seed >> 1);
    const pressureSlice = rotateTake(pressures, 4, seed >> 2);
    candidates = eraSlice.map((label, index) => ({
      label,
      intent: `${powerSlice[index % powerSlice.length]}，${pressureSlice[index % pressureSlice.length]}`,
    }));
  }

  if (field.key === "genre") {
    const frontPoolsByFlavor = {
      court: ["后宫暗流", "内廷与朝堂", "被压下的宫闱旧案", "失势者的复起局", "家族与凤位之争"],
      urban: ["公司高层黑幕", "城市边缘秘案", "权力机构内斗", "被清理过的旧记录", "上层交易链"],
      fantasy: ["宗门权位更替", "被封禁的术法真相", "仙门与王权边界", "师门旧债", "灵脉衰竭后的乱局"],
      general: ["权力漩涡中心", "被压下的真相", "多方试探的密局", "失势后的反制局", "一件牵出旧账的异常"],
    };
    const enginePoolsByFlavor = {
      court: ["争宠借势", "权谋试探", "借刀破局", "查案翻线", "暗中结盟"],
      urban: ["调查追查", "潜伏反制", "交换筹码", "顺线摸底", "借势翻盘"],
      fantasy: ["破禁追源", "宗门试探", "旧债清算", "势力结盟", "禁术反噬"],
      general: ["追线破局", "权力反制", "慢慢翻盘", "互探底牌", "借势上位"],
    };
    const pressurePoolsByFlavor = {
      court: ["每一步都要押对人心", "局势越静越危险", "一句失言都可能反噬", "温柔表面下全是针"],
      urban: ["越靠近真相越容易被灭口", "规则写在纸上，刀落在暗处", "每层关系都带着代价", "监控之外才是真正的战场"],
      fantasy: ["越碰真相越会触动禁忌", "恩义和戒律随时会反咬", "所有平静都像在给风暴蓄势", "灵力与人心一样不可靠"],
      general: ["每前进一步都要付代价", "局中人没有一个真的干净", "看似平静的局面随时会翻面", "越接近答案越难全身而退"],
    };
    const fronts = rotateTake(frontPoolsByFlavor[flavor], 4, seed);
    const engines = rotateTake(enginePoolsByFlavor[flavor], 4, seed >> 1);
    const pressures = rotateTake(pressurePoolsByFlavor[flavor], 4, seed >> 2);
    candidates = fronts.map((front, index) => ({
      label: `${front}里的${engines[index % engines.length]}`,
      intent: `${pressures[index % pressures.length]}，主线会围着${front}持续推进`,
    }));
  }

  if (field.key === "protagonist") {
    const rolePoolsByFlavor = {
      court: ["新入局的妃嫔", "表面失势的皇后", "掌簿女官", "外来谋士", "奉命入局的医女"],
      urban: ["被当成弃子的调查员", "刚升进核心层的秘书", "握着线人的中间人", "误入漩涡的集团新人", "替上层背锅的执行者"],
      fantasy: ["刚入内门的弟子", "被贬回山的旧传人", "掌秘库的执事", "背债入局的散修", "奉命下山的司录使"],
      general: ["被推到风口的新人", "表面失势却还握着筹码的人", "知道一角内幕的执行者", "不想站队的旁观者", "被临时拖下水的局外人"],
    };
    const positionPoolsByFlavor = {
      court: ["却被提前盯上", "手里压着一段旧账", "看似无宠却被暗中需要", "背后没有靠山", "刚好站在最危险的位置"],
      urban: ["刚好撞见不该看到的东西", "名义上有职权、实则没有退路", "表面干净却背着旧记录", "被几方同时试探", "离真相只差半步"],
      fantasy: ["一脚踩进禁令边缘", "身上带着宗门旧债", "表面不起眼却碰过关键秘辛", "被各峰同时盯上", "与某段失传旧事有牵连"],
      general: ["却被局势提前卷入", "手里握着一点别人没有的东西", "站得不高却看得太多", "背着不能明说的前账", "刚进局就被推到前台"],
    };
    const motives = [
      "从这个切口开局，关系和筹码会更快咬合起来",
      "这个身份方便被各方拉拢、试探或利用",
      "这个位置天生适合卷进秘密和反转",
      "这个起点会让后续选择更疼，也更有戏",
      "从这里入局，人物弧光会比较强",
    ];
    const roles = rotateTake(rolePoolsByFlavor[flavor], 4, seed);
    const positions = rotateTake(positionPoolsByFlavor[flavor], 4, seed >> 1);
    const motiveSlice = rotateTake(motives, 4, seed >> 2);
    candidates = roles.map((role, index) => ({
      label: `${role}，${positions[index % positions.length]}`,
      intent: motiveSlice[index % motiveSlice.length],
    }));
  }

  if (field.key === "tone") {
    const moods = ["压抑紧绷", "华丽危险", "冷静克制", "高压黑暗", "锋利机巧", "暧昧悬疑", "沉静而带后劲"];
    const rhythms = ["慢刀试探", "步步逼近", "节奏偏快", "留白里带压迫", "每一拍都像试探底线", "表面平静、底下很急"];
    const textures = [
      "环境压迫感更强",
      "对白要带刺",
      "更强调心理波动和停顿",
      "细节要像贴着呼吸往前推",
      "更适合写试探和失衡",
      "整体读起来要有冷意和后劲",
    ];
    const moodSlice = rotateTake(moods, 4, seed);
    const rhythmSlice = rotateTake(rhythms, 4, seed >> 1);
    const textureSlice = rotateTake(textures, 4, seed >> 2);
    candidates = moodSlice.map((mood, index) => ({
      label: `${mood}，${rhythmSlice[index % rhythmSlice.length]}`,
      intent: `${textureSlice[index % textureSlice.length]}，更像一部真正的互动小说`,
    }));
  }

  if (field.key === "boundaries") {
    const softenVerbs = ["尽量淡化", "不要重写", "避免核心推进依赖", "可以少量带到，但别铺开"];
    const topicA = ["直白血腥", "酷刑羞辱", "纯恋爱主导", "过重惊悚", "极端压迫关系", "太晦涩的设定解释"];
    const topicB = ["身体折磨", "羞辱惩罚", "单纯撒糖式推进", "恐怖氛围", "关系失衡的压迫感", "大段设定讲解"];
    const flexibleModes = [
      { label: "可以自由发挥，不额外设限", intent: "先按主线张力优先推进" },
      { label: "保留锋利感，但不要故意堆重口", intent: "允许冲突，但别为了刺激感牺牲故事" },
    ];
    const verbSlice = rotateTake(softenVerbs, 3, seed);
    const topicSliceA = rotateTake(topicA, 3, seed >> 1);
    const topicSliceB = rotateTake(topicB, 3, seed >> 2);
    candidates = verbSlice.map((verb, index) => ({
      label: `${verb}${topicSliceA[index % topicSliceA.length]}和${topicSliceB[index % topicSliceB.length]}描写`,
      intent: "把这条边界写进后续生成约束",
    }));
    candidates.push(flexibleModes[seed % flexibleModes.length]);
  }

  return normalizeChoices(candidates);
}

function buildFallbackSetupAck(playerInput) {
  return playerInput ? "我记下来了，继续把剩余关键信息补齐。" : "先把故事底色定下来。";
}

function rememberLocalAgentResult(memory, config, agentId, payload) {
  remember(memory, payload.summary || `${agentId} completed`, payload);
  compressIfNeeded(memory, config.maxContextBudget);
}

function buildCharacterVisualDigest(characterState) {
  const playerProfile = characterState.playerProfile || {};
  const lines = [
    `玩家：身份=${playerProfile.role || "未定"}；外貌=${playerProfile.appearance || "未定"}；装扮=${playerProfile.outfit || "未定"}`,
  ];

  (characterState.npcs || []).slice(0, 4).forEach((npc) => {
    lines.push(
      `${npc.name}：职责=${npc.role || "未定"}；状态=${npc.status || "未定"}；外貌=${npc.appearance || "未定"}；装扮=${npc.outfit || "未定"}`
    );
  });

  return lines.join("\n");
}

function buildCharacterUpdateDigest(characterState) {
  const playerProfile = characterState.playerProfile || {};
  const playerSummary = `玩家：身份=${playerProfile.role || "未定"}；驱动力=${playerProfile.drive || "未定"}；秘密=${playerProfile.secret || "无"}；装扮=${playerProfile.outfit || "未定"}`;
  const npcSummary = (characterState.npcs || [])
    .slice(0, 4)
    .map(
      (npc) =>
        `${npc.name}：职责=${npc.role || "未定"}；目标=${npc.goal || "未定"}；状态=${npc.status || "未定"}；信任=${npc.trust ?? 0}；装扮=${npc.outfit || "未定"}`
    )
    .join("\n");
  const relationshipSummary = Array.isArray(characterState.relationships) && characterState.relationships.length
    ? `关系：${characterState.relationships.join(" / ")}`
    : "关系：暂无";

  return [playerSummary, npcSummary, relationshipSummary].filter(Boolean).join("\n");
}

function buildPlanDigest(plan) {
  if (!plan || typeof plan !== "object") {
    return "无";
  }

  return [
    `sceneGoal=${plan.sceneGoal || "无"}`,
    `beat=${plan.beat || "无"}`,
    `worldNeeds=${normalizeNeedList(plan.worldNeeds).join("；") || "无"}`,
    `characterNeeds=${normalizeNeedList(plan.characterNeeds).join("；") || "无"}`,
  ].join("\n");
}

function runLocalFormatAgent(memory, config, agentId, draft, summary) {
  const messages = parseDraftMessages(draft);
  const payload = {
    summary: summary || "格式整理完成。",
    messages: messages.length
      ? messages
      : [
          {
            type: "system",
            speakerName: "系统旁白",
            text: String(draft || "场景继续推进。").trim() || "场景继续推进。",
          },
        ],
  };
  rememberLocalAgentResult(memory, config, agentId, payload);
  return payload;
}

function parseDraftMessages(draft) {
  return String(draft || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const delimiterIndex = line.includes("：") ? line.indexOf("：") : line.indexOf(":");
      if (delimiterIndex < 0) {
        return {
          type: "system",
          speakerName: "系统旁白",
          text: line,
        };
      }

      const speaker = line.slice(0, delimiterIndex).trim();
      const text = line.slice(delimiterIndex + 1).trim();
      const isSystem = /^(系统旁白|旁白|系统)$/.test(speaker);
      return {
        type: isSystem ? "system" : "npc",
        speakerName: isSystem ? "系统旁白" : speaker || "角色",
        text: text || line,
      };
    });
}

function getRequestOptionsForAgent(agentId) {
  const optionsByAgent = {
    "plot.setup": { maxTokens: 520, timeoutMs: 60000 },
    "world.bootstrap": { maxTokens: 520, timeoutMs: 70000 },
    "character.bootstrap": { maxTokens: 900, timeoutMs: 90000 },
    "plot.bootstrap": { maxTokens: 1500, timeoutMs: 100000 },
    "plot.turn": { maxTokens: 1850, timeoutMs: 105000 },
    "world.turn": { maxTokens: 420, timeoutMs: 60000 },
    "character.turn": { maxTokens: 760, timeoutMs: 75000 },
  };

  return optionsByAgent[agentId] || { maxTokens: 700, timeoutMs: 70000 };
}

function buildPlotSetupPrompt(snapshot, playerInput, targetField) {
  const answers = collectSetupAnswers(snapshot.storyState) || "暂无";
  const remainingRequired = getMissingSetupFields(snapshot.storyState)
    .map((field) => `${field.label}(${field.key})`)
    .join("、") || "无";
  return `你是剧情控制 agent 的建档阶段，但你不负责决定流程是否结束。主 agent 已经决定本轮必须补齐字段「${targetField.label}（${targetField.key}）」。

当前已知回答：
${answers}

当前仍缺少的必填字段：
${remainingRequired}

最新玩家回答：
${playerInput || "无，准备开启第一问"}

请只输出 JSON：
{
  "summary": "一句话总结当前建档进度",
  "ack": "对玩家上轮回答的简短承接",
  "question": "下一条问题，准备给格式 agent 使用",
  "choices": [{"label":"...", "intent":"..."}],
  "field": "${targetField.key}"
}

要求：
1. 只问一个问题。
 2. 问题必须只围绕「${targetField.label}」展开，不要继续追问已经回答过的字段。
 3. 本轮只预设字段类别，不要复用固定模板问题；请根据已知答案现场生成更具体的提问方式。
 4. 选项需要动态生成 3 到 4 个，必须贴合当前已知设定，不要直接照搬固定示例词。
 5. 问题要具体，适合手机聊天界面。
 6. 不要自己宣布 ready，也不要自行切换到别的字段。

本轮字段说明：
${targetField.guidance}`;
}

function plotSetupMock(snapshot, playerInput, targetField) {
  return {
    summary: `建档继续收集 ${targetField.label}`,
    field: targetField.key,
    ack: buildFallbackSetupAck(playerInput),
    question: {
      speakerName: "格式 agent",
      text: buildDynamicSetupQuestion(targetField, snapshot.storyState),
    },
    choices: buildDynamicSetupChoices(targetField, snapshot.storyState),
  };
}

function buildWorldPrompt(snapshot, setupDigest) {
  return `你是世界控制 agent。请根据玩家偏好和剧情摘要生成一个紧凑的世界设定包。

偏好摘要：
${setupDigest}

只输出 JSON：
{
  "summary": "世界观一句话摘要",
  "rules": ["核心规则"],
  "locations": ["关键地点"],
  "activeForces": ["当前主要力量"],
  "recentEvents": ["开局前发生了什么"]
}

要求：
1. 内容适合长线互动叙事。
2. 控制在关键内容，不要流水账。
3. 与玩家偏好一致。
4. 不要输出 markdown 代码块，不要解释，只返回 JSON。`;
}

function worldMock(snapshot, setupDigest) {
  const world = snapshot.storyState.setup.answers.world || "现代都市";
  const tone = snapshot.storyState.setup.answers.tone || "紧张压迫";
  return {
    summary: `${world}背景下，一座表面安静、暗潮汹涌的城市即将把主角卷入失控事件。整体氛围偏${tone}。`,
    rules: [
      "每次重大行动都会留下可追踪后果。",
      "信息并不完整，关键真相需要逐层挖掘。",
      "人物关系会因为玩家态度发生偏移。",
    ],
    locations: ["旧城区档案馆", "河岸轻轨站", "夜间营业的茶室"],
    activeForces: ["沉默的地方势力", "隐藏在公共机构中的观察者", "一支立场不明的小团体"],
    recentEvents: ["三天前发生了一起被压下的离奇事件。", "有人开始追查一份失踪的记录。"],
  };
}

function buildCharacterPrompt(snapshot) {
  return `你是角色控制 agent。请基于以下信息建立玩家与 NPC 的初始角色结构。

偏好摘要：
${collectSetupAnswers(snapshot.storyState)}

世界摘要：
${snapshot.storyState.worldState.summary}

只输出 JSON：
{
  "summary": "角色系统一句话摘要",
  "playerProfile": {
    "role": "玩家身份",
    "drive": "玩家的核心驱动力",
    "secret": "可选的隐性矛盾",
    "appearance": "外貌特征",
    "outfit": "当前装扮",
    "outfitHistory": ["初始装扮记录"]
  },
  "npcs": [
    {
      "id":"npc-1",
      "name":"名字",
      "role":"职责",
      "goal":"目标",
      "tone":"说话气质",
      "status":"当前状态",
      "trust":0,
      "appearance":"外貌特征",
      "outfit":"当前装扮",
      "outfitHistory":["初始装扮记录"]
    }
  ],
  "relationships": ["角色关系摘要"]
}

要求：
1. 至少生成 3 个 NPC。
2. NPC 要有不同功能和冲突点。
3. 玩家身份要能自然进入主线。
4. 玩家和 NPC 都必须有稳定的外貌描述与初始装扮记录。
5. 不要输出 markdown 代码块，不要解释，只返回 JSON。`;
}

function characterMock(snapshot) {
  const protagonist = snapshot.storyState.setup.answers.protagonist || "普通人卷入事件";
  return {
    summary: `玩家作为${protagonist}进入事件核心，外貌与装束已经明确，身边围绕着一位线索提供者、一位立场不明的盟友和一位潜在对手。`,
    playerProfile: {
      role: protagonist,
      drive: "想弄清事件真相，同时保护自己在意的人。",
      secret: "过去似乎与这起事件有隐约关联。",
      appearance: "眉眼沉静，神色克制，像总在先看清局势再开口的人。",
      outfit: "一身便于夜行的素色常服，外罩轻薄披风，袖口收得利落。",
      outfitHistory: ["开局时穿着素色常服与轻薄披风。"],
    },
    npcs: [
      {
        id: "npc-yao",
        name: "姚汀",
        role: "递来第一条线索的人",
        goal: "逼主角尽快行动",
        tone: "冷静、直接",
        status: "谨慎观察中",
        trust: 1,
        appearance: "身形清瘦，眼神锐利，脸上几乎没有多余表情。",
        outfit: "深灰短外套配利落长裤，衣料低调但剪裁干净。",
        outfitHistory: ["初次登场时穿着深灰短外套与利落长裤。"],
      },
      {
        id: "npc-lin",
        name: "林折",
        role: "掌握城市边缘情报的灰色中间人",
        goal: "在风险和利益之间保持平衡",
        tone: "轻佻、会试探",
        status: "半合作状态",
        trust: 0,
        appearance: "笑意总挂在嘴角，发丝微乱，像从不把自己彻底交给规矩。",
        outfit: "暗纹衬衫外松垮长风衣，袖口和领口都带一点刻意的散漫。",
        outfitHistory: ["初次登场时是暗纹衬衫配松垮长风衣。"],
      },
      {
        id: "npc-zhou",
        name: "周霁",
        role: "看似站在秩序一侧的关键人物",
        goal: "维持局面，隐藏更深的真相",
        tone: "克制、压迫感强",
        status: "尚未完全表态",
        trust: -1,
        appearance: "面容端正冷峻，站姿笔直，目光像一把始终未出鞘的刀。",
        outfit: "深色制式外套一丝不苟，肩线锋利，连袖扣都没有偏差。",
        outfitHistory: ["初次登场时穿着一丝不苟的深色制式外套。"],
      },
    ],
    relationships: [
      "姚汀相信玩家有能力，但不完全信任动机。",
      "林折把玩家视为值得下注的新变量。",
      "周霁知道更多真相，正在评估玩家是否危险。",
    ],
  };
}

function buildPlotBlueprintPrompt(snapshot) {
  return `你是剧情控制 agent。现在建档已完成，请根据世界和角色信息生成主线结构。

世界摘要：
${snapshot.storyState.worldState.summary}

角色摘要：
${snapshot.storyState.characterState.summary || ""}

只输出 JSON：
{
  "summary": "主线一句话",
  "title": "故事标题",
  "premise": "故事开局 premise",
  "currentBeat": "开场剧情节点",
  "milestones": ["关键节点"],
  "activeThreads": ["当前悬而未决的问题"],
  "openingObjective": "玩家现在最先要做什么",
  "openingDraft": "开场剧情草稿，偏小说化的多行文本；每行都必须是「系统旁白：...」或「角色名：...」",
  "openingChoices": [{"label":"...", "intent":"...", "payload":"..."}],
  "openingInputHint": "输入提示"
}

要求：
1. 不要输出 markdown 代码块，不要解释，只返回 JSON。
2. summary、milestones 这些结构字段保持紧凑，但 openingDraft 必须有互动小说的叙事感，要写出环境、动作、情绪或压迫感。
3. openingDraft 写 4 到 7 行，每行都要以「系统旁白：」或「角色名：」开头；每行可以是一小段完整叙述或对白，允许 1 到 3 句。
4. openingChoices 提供 2 到 4 个。`;
}

function plotBlueprintMock(snapshot) {
  const genre = snapshot.storyState.setup.answers.genre || "悬疑推进";
  const guideName = snapshot.storyState.characterState.npcs[0]?.name || "陌生人";
  return {
    summary: `一场被压下的异常事件正在扩大，玩家必须在不同势力之间选择合作与怀疑，逐步揭开城市暗面的真相。`,
    title: `${genre}之城`,
    premise: "一份消失的记录把玩家推向三股彼此防备的力量中心。",
    currentBeat: "引子：陌生人发来会面的坐标。",
    milestones: [
      "确认第一条线索的真伪",
      "识别真正操盘的一方",
      "在公开崩坏前做出立场选择",
    ],
    activeThreads: ["是谁删掉了那份记录？", "姚汀为什么选中玩家？", "周霁到底在保护什么？"],
    openingObjective: "赶去约定地点，与姚汀接头并判断她是否可信。",
    openingDraft: [
      "系统旁白：夜色把城市压成一整片潮湿的铁灰色。你刚从便利店屋檐下躲开一阵细雨，手机便在掌心里轻轻震了一下，亮起的屏幕上只有一条没有署名的消息。",
      "系统旁白：消息里没有寒暄，没有解释，只有一处河岸轻轨站的定位，以及一句像命令又像警告的话: 别迟到。短短三个字，却像有人隔着屏幕已经看清了你此刻的迟疑。",
      "系统旁白：你盯着那行字看了几秒，雨水顺着广告牌的边缘往下淌，落在鞋尖前，碎成一片昏黄霓虹。你很清楚，三天前那份凭空消失的记录不会自己回来，而眼下这条消息，多半就是裂缝第一次真正朝你张开。",
      `${guideName}：如果你真的想知道三天前发生了什么，就现在来河岸轻轨站。别带太多人，也别把信任带来。`,
      "系统旁白：风从高架桥下穿过去，带着一点锈味和河水腥气。你把手机收进口袋时，忽然意识到自己已经在往前迈步了，像是从看见那条消息开始，故事就不再允许你站在原地。",
    ].join("\n"),
    openingChoices: normalizeChoices([
      { label: "立刻赶去轻轨站", intent: "主动推进剧情", payload: "我马上过去。" },
      { label: "先追问她的身份", intent: "试探 NPC", payload: "你到底是谁？" },
      { label: "绕路去档案馆摸底", intent: "谨慎调查", payload: "在赴约前，我想先查档案馆。" },
    ]),
    openingInputHint: "输入你的对白、试探或行动",
  };
}

function buildPlotTurnPrompt(snapshot, playerInput) {
  return `你是剧情控制 agent。请在本回合完成剧情审查、推进规划，并直接写出本回合剧情草稿。

玩家输入：
${playerInput}

当前主线：
${snapshot.storyState.plotState.summary}

当前目标：
${snapshot.storyState.currentObjective}

世界摘要：
${snapshot.storyState.worldState.summary}

角色摘要：
${snapshot.storyState.characterState.summary || ""}

请只输出 JSON：
{
  "summary": "本回合剧情推进摘要",
  "review": {
    "consistency": "ok 或 warn",
    "warnings": ["风险提醒"],
    "canonCheck": "简短结论"
  },
  "plan": {
    "sceneGoal": "这一拍要达成什么",
    "beat": "新的剧情拍点",
    "worldNeeds": ["如果世界没有持久变化就留空"],
    "characterNeeds": ["如果角色没有持久变化就留空"],
    "stateMutationHints": {
      "world": {
        "shouldUpdate": true,
        "reason": "为什么这一回合需要或不需要调用世界 agent",
        "scope": "世界事实/地点状态/势力动向/规则变化"
      },
      "character": {
        "shouldUpdate": false,
        "reason": "为什么这一回合需要或不需要调用角色 agent",
        "scope": "角色信任/关系/身份/伤势/去向"
      }
    },
    "choiceBlueprints": [{"label":"...", "intent":"...", "payload":"..."}],
    "inputHint": "输入提示"
  },
  "stateUpdates": {
    "currentObjective": "新的当前目标",
    "activeThreads": ["新的悬念"],
    "dangerLevel": "低/中/高"
  },
  "draft": "本回合剧情草稿，偏小说化的多行文本；每行都必须是「系统旁白：...」或「角色名：...」"
}

要求补充：
1. draft 由你直接写作，再交给格式 agent 拆成玩家可见消息。
2. draft 要写出互动小说感，不要只给简报句。
3. draft 写 4 到 7 行，每行都要以「系统旁白：」或「角色名：」开头；每行可以是一小段完整叙述或对白，允许 1 到 3 句。
4. choiceBlueprints 和 inputHint 继续输出，用于主 agent 推进下一步。`;
}

function plotTurnMock(snapshot, playerInput) {
  const input = (playerInput || "").trim();
  const sceneCounter = (snapshot.storyState.plotState.sceneCounter || 0) + 1;
  const mentionsInquiry = /(查|问|调查|档案|真相|线索|观察)/.test(input);
  const mentionsTrust = /(相信|合作|一起|帮你|跟你走)/.test(input);
  const mentionsForce = /(打|威胁|抢|逼|闯)/.test(input);
  const mentionsOutfitChange = /(换装|更衣|换上|披上|穿上|摘下|伪装|打扮|衣裳|衣服|官服|常服|礼服|斗篷)/.test(
    input
  );
  const currentNpc = snapshot.storyState.characterState.npcs[sceneCounter % snapshot.storyState.characterState.npcs.length];

  let beat = "会面拉开序幕";
  let sceneGoal = "判断眼前信息的可信度。";
  let objective = "从交谈中拿到能验证的线索。";
  let activeThreads = [...snapshot.storyState.plotState.activeThreads];
  let dangerLevel = "低";
  let worldShouldUpdate = false;
  let characterShouldUpdate = false;
  let worldReason = "本回合主要是气氛和信息交换，没有新的长期世界事实落地。";
  let characterReason = "本回合没有角色关系或状态上的持久变化。";

  if (mentionsInquiry) {
    beat = "玩家主动调查，让隐藏线索前置浮现";
    sceneGoal = "让一条可验证的新线索浮出水面。";
    objective = "顺着新线索找到第一处异常现场。";
    activeThreads = [...activeThreads, "线索是否指向档案馆内部人员？"];
    worldShouldUpdate = true;
    worldReason = "新的外部异常被确认，需要写入世界事实与环境动向。";
  } else if (mentionsTrust) {
    beat = "玩家主动建立合作，角色关系开始绑定";
    sceneGoal = "让盟友愿意透露更多。";
    objective = "通过合作换来更核心的情报。";
    dangerLevel = "中";
    characterShouldUpdate = true;
    characterReason = "玩家表达了合作意愿，NPC 的信任与关系需要更新。";
  } else if (mentionsForce) {
    beat = "玩家的强硬举动打乱平衡";
    sceneGoal = "在后果失控前稳住局面。";
    objective = "处理你制造出的压力和反噬。";
    dangerLevel = "高";
    worldShouldUpdate = true;
    characterShouldUpdate = true;
    worldReason = "玩家的强硬动作会改变外部风险和势力关注度。";
    characterReason = "当前 NPC 会因你的强硬行为调整态度和信任。";
  }

  if (mentionsOutfitChange) {
    if (!mentionsInquiry && !mentionsTrust && !mentionsForce) {
      beat = "玩家主动调整外在形象";
      sceneGoal = "让新的装束与身份策略在当前场景生效。";
      objective = "用更新后的形象继续接近线索与目标人物。";
    }
    characterShouldUpdate = true;
    characterReason =
      mentionsTrust || mentionsForce
        ? `${characterReason} 同时还要更新装扮记录。`
        : "玩家或角色的装扮发生变化，需要更新外貌与装扮记录。";
  }

  return {
    summary: beat,
    review: {
      consistency: "ok",
      warnings: mentionsForce ? ["强硬行动会迅速拉高世界风险。"] : [],
      canonCheck: "输入可以自然并入当前主线。",
    },
    plan: {
      sceneGoal,
      beat,
      worldNeeds: worldShouldUpdate
        ? [mentionsInquiry ? "揭示一条与档案馆有关的外部异常" : "记录玩家动作引发的外部风险上升"]
        : [],
      characterNeeds: characterShouldUpdate
        ? [mentionsTrust ? "提升一位 NPC 的信任" : "记录当前 NPC 的防备与关系变化"]
        : [],
      stateMutationHints: {
        world: {
          shouldUpdate: worldShouldUpdate,
          reason: worldReason,
          scope: worldShouldUpdate ? "世界事实、外部风险或势力动向" : "无",
        },
        character: {
          shouldUpdate: characterShouldUpdate,
          reason: characterReason,
          scope: characterShouldUpdate ? "角色信任、关系与当前状态" : "无",
        },
      },
      choiceBlueprints: normalizeChoices([
        { label: "继续追问细节", intent: "深挖信息", payload: "把你知道的细节全部说清楚。" },
        { label: "先观察周围环境", intent: "保持谨慎", payload: "我先看看周围有没有异常。" },
        { label: `把话题转向${currentNpc.name}`, intent: "切换关注对象", payload: `我想知道${currentNpc.name}在这件事里的位置。` },
      ]),
      inputHint: "继续输入对白、判断或行动",
    },
    stateUpdates: {
      currentObjective: objective,
      activeThreads: activeThreads.slice(-5),
      dangerLevel,
    },
    draft: [
      `系统旁白：你的回应落下之后，四周的空气像被一根无形的线猛地绷紧了。${sceneGoal}连廊尽头的灯火被夜风吹得忽明忽暗，连地砖上潮气都像在悄悄挪动位置。`,
      `系统旁白：你没有立刻再开口，只让视线顺着眼前人的肩侧滑向更深的阴影处。那里安静得过分，像是藏着比这场对话本身更早抵达的秘密。`,
      `${currentNpc.name}：${buildNpcLine(currentNpc.name, playerInput, dangerLevel)}`,
      `系统旁白：${currentNpc.name}说话时并没有真正看向你，像是连一个多余的眼神都可能暴露立场。可正因为如此，那些被刻意压低的字句反而显得更真，也更危险。`,
      dangerLevel === "高"
        ? "系统旁白：远处忽然传来一阵急促而不成节奏的脚步声，像有人在黑暗里临时改变了方向。那动静不大，却足够让你意识到，自己刚才的举动已经把更多目光牵到了这里。"
        : "系统旁白：周围的细节开始一点点松动，风穿过栏杆缝隙时带出细碎回响，像整座场景都在屏息，等你做出下一次判断。",
    ].join("\n"),
  };
}

function normalizeNeedList(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeUpdateDecision(rawHint, fallbackNeeds, fallbackReason) {
  const needs = normalizeNeedList(fallbackNeeds);
  const shouldUpdate =
    typeof rawHint?.shouldUpdate === "boolean" ? rawHint.shouldUpdate : needs.length > 0;
  const reason =
    (typeof rawHint?.reason === "string" && rawHint.reason.trim()) ||
    (shouldUpdate ? needs.join("；") : fallbackReason);

  return {
    shouldUpdate,
    reason,
    scope: typeof rawHint?.scope === "string" ? rawHint.scope.trim() : "",
    needs,
  };
}

function decideStateAgentCalls(plotResult) {
  const mutationHints = plotResult?.plan?.stateMutationHints || {};
  return {
    world: normalizeUpdateDecision(
      mutationHints.world,
      plotResult?.plan?.worldNeeds,
      "没有检测到需要持久记录的世界变化。"
    ),
    character: normalizeUpdateDecision(
      mutationHints.character,
      plotResult?.plan?.characterNeeds,
      "没有检测到需要持久记录的角色变化。"
    ),
  };
}

function buildWorldUpdatePrompt(snapshot, plotResult, playerInput) {
  return `你是世界控制 agent。根据本回合剧情计划和玩家行动，更新世界事实。

玩家输入：${playerInput}
剧情计划：${JSON.stringify(plotResult.plan)}
当前世界摘要：${snapshot.storyState.worldState.summary}

只输出 JSON：
{
  "summary": "更新后的世界摘要",
  "delta": {
    "recentEvents": ["新增事件"],
    "locations": ["需要强调的地点变化"],
    "activeForces": ["势力动向"]
  }
}`;
}

function worldUpdateMock(snapshot, plotResult) {
  const recentEvents = [...snapshot.storyState.worldState.recentEvents];
  recentEvents.push(plotResult.plan.sceneGoal);
  return {
    summary: `${snapshot.storyState.worldState.summary} 今晚的城市节奏开始加快，新的异常正在逼近表面。`,
    delta: {
      recentEvents: recentEvents.slice(-4),
      locations: snapshot.storyState.worldState.locations.slice(0, 3),
      activeForces: [
        ...snapshot.storyState.worldState.activeForces.slice(0, 2),
        plotResult.stateUpdates.dangerLevel === "高"
          ? "更多眼线开始注意玩家的行动。"
          : "暗中的观察还在继续，但尚未公开撕裂。",
      ].slice(-3),
    },
  };
}

function buildCharacterUpdatePrompt(snapshot, plotResult, playerInput) {
  return `你是角色控制 agent。根据本回合剧情计划和玩家输入，更新角色状态。

玩家输入：${playerInput}
剧情计划：
${buildPlanDigest(plotResult.plan)}
当前角色摘要：${snapshot.storyState.characterState.summary || ""}
当前角色结构：
${buildCharacterUpdateDigest(snapshot.storyState.characterState)}

只输出 JSON：
{
  "summary": "更新后的角色摘要",
  "delta": {
    "playerProfile": {
      "appearance": "若无变化可省略",
      "outfit": "若换装则填写",
      "outfitHistory": ["若有新装扮记录则填写"]
    },
    "npcs": [
      {
        "id":"npc-id",
        "status":"新的状态",
        "trust":1,
        "appearance":"若无变化可省略",
        "outfit":"若换装则填写",
        "outfitHistory":["若有新装扮记录则填写"]
      }
    ],
    "relationships": ["关系变化"]
  }
}

要求：
1. 角色 agent 负责维护外貌与装扮记录。
2. 外貌通常稳定，除非剧情明确改变。
3. 装扮变化要同步写入当前 outfit 和 outfitHistory。
4. 不要输出 markdown 代码块，不要解释，只返回 JSON。`;
}

function characterUpdateMock(snapshot, plotResult, playerInput) {
  const mentionsTrust = /(相信|合作|一起|帮你|跟你走)/.test(playerInput);
  const mentionsForce = /(打|威胁|抢|逼|闯)/.test(playerInput);
  const mentionsOutfitChange = /(换装|更衣|换上|披上|穿上|摘下|伪装|打扮|衣裳|衣服|官服|常服|礼服|斗篷)/.test(
    playerInput
  );
  const leadNpc = snapshot.storyState.characterState.npcs[0];
  const trustShift = mentionsTrust ? 1 : mentionsForce ? -1 : 0;
  const playerProfile = snapshot.storyState.characterState.playerProfile || {};
  const nextOutfit = mentionsOutfitChange
    ? "换上更便于隐藏身份的低调伪装，层次更轻，细节被刻意收敛。"
    : playerProfile.outfit;
  const nextOutfitHistory = mentionsOutfitChange
    ? [...(playerProfile.outfitHistory || []), `本回合后改成：${nextOutfit}`].slice(-6)
    : playerProfile.outfitHistory || [];

  return {
    summary: mentionsOutfitChange
      ? `角色关系与装扮记录都发生了变化，新的外观线索需要持续记住。`
      : `人物关系开始围绕玩家的表达方式产生轻微偏移。`,
    delta: {
      playerProfile: mentionsOutfitChange
        ? {
            outfit: nextOutfit,
            outfitHistory: nextOutfitHistory,
          }
        : {},
      npcs: snapshot.storyState.characterState.npcs.map((npc, index) => ({
        id: npc.id,
        status:
          index === 0
            ? trustShift > 0
              ? "试着向玩家交出更多情报"
              : trustShift < 0
              ? "变得防备并准备抽身"
              : "继续观察玩家是否值得信任"
            : npc.status,
        trust: index === 0 ? npc.trust + trustShift : npc.trust,
      })),
      relationships: [
        ...snapshot.storyState.characterState.relationships.slice(-2),
        mentionsOutfitChange
          ? `玩家更换了更低调的装束，角色们对其意图的判断会随之变化。`
          : trustShift > 0
          ? `${leadNpc.name}对玩家的戒备略微下降。`
          : trustShift < 0
          ? `${leadNpc.name}开始重新评估玩家是否可靠。`
          : `${leadNpc.name}仍未完全亮明立场。`,
      ].slice(-4),
    },
  };
}

function buildNpcLine(name, playerInput, dangerLevel) {
  if (dangerLevel === "高") {
    return `${name}盯着你，声音压得很低：“你最好知道自己在做什么。再快一步，我们就都会被看见。”`;
  }
  if (/(查|问|调查|档案|真相|线索|观察)/.test(playerInput)) {
    return `${name}把视线往旁边一偏：“你要的不是答案，是入口。旧城区档案馆今晚有人提前清场，这事不正常。”`;
  }
  if (/(相信|合作|一起|帮你|跟你走)/.test(playerInput)) {
    return `${name}短暂沉默后点了点头：“好，那我先交一半。剩下的一半，要看你能不能活着走到下一站。”`;
  }
  return `${name}轻轻敲了敲桌面：“别急着站队。先证明你能分辨谁在撒谎。”`;
}

function buildSkippedWorldResult(snapshot, decision) {
  return {
    summary: snapshot.storyState.worldState.summary,
    delta: {},
    skipped: true,
    reason: decision.reason,
  };
}

function buildSkippedCharacterResult(snapshot, decision) {
  return {
    summary: snapshot.storyState.characterState.summary,
    delta: {
      playerProfile: {},
      npcs: [],
      relationships: [],
    },
    skipped: true,
    reason: decision.reason,
  };
}

function appendMessages(snapshot, messages) {
  const normalized = messages.map((message) => ({
    id: createId("msg"),
    type: message.type === "npc" ? "npc" : message.type === "player" ? "player" : "system",
    speakerName: message.speakerName || (message.type === "npc" ? "角色" : "系统旁白"),
    text: message.text || "",
    timestamp: nowIso(),
  }));
  snapshot.chatTranscript = [...snapshot.chatTranscript, ...normalized];
}

function buildStatusText(storyState) {
  if (storyState.phase === "setup") {
    return "建档中：剧情 agent 正在收集你的偏好。";
  }
  if (storyState.phase === "play") {
    return "当前回合已就绪，等待你的下一步。";
  }
  if (storyState.phase === "ended") {
    return "故事已结束，可以回看记录或开始新的故事。";
  }
  return "先配置模型，然后开始一段新的故事。";
}

function mergeCharacterState(currentState, characterUpdate) {
  const incomingPlayerProfile =
    characterUpdate?.delta?.playerProfile && typeof characterUpdate.delta.playerProfile === "object"
      ? characterUpdate.delta.playerProfile
      : null;
  const incomingNpcs = Array.isArray(characterUpdate?.delta?.npcs) ? characterUpdate.delta.npcs : [];
  const incomingRelationships = Array.isArray(characterUpdate?.delta?.relationships)
    ? characterUpdate.delta.relationships
    : null;
  const trustMap = new Map(incomingNpcs.map((item) => [item.id, item]));
  const currentPlayerProfile = currentState.playerProfile || {};
  const mergedPlayerProfile = {
    ...currentPlayerProfile,
    ...(incomingPlayerProfile || {}),
    outfitHistory:
      Array.isArray(incomingPlayerProfile?.outfitHistory) && incomingPlayerProfile.outfitHistory.length
        ? incomingPlayerProfile.outfitHistory.slice(-6)
        : currentPlayerProfile.outfitHistory || [],
  };
  return {
    ...currentState,
    summary: characterUpdate.summary || currentState.summary,
    playerProfile: mergedPlayerProfile,
    npcs: currentState.npcs.map((npc) => {
      const update = trustMap.get(npc.id);
      return update
        ? {
            ...npc,
            name: update.name ?? npc.name,
            role: update.role ?? npc.role,
            goal: update.goal ?? npc.goal,
            tone: update.tone ?? npc.tone,
            status: update.status ?? npc.status,
            trust: update.trust ?? npc.trust,
            appearance: update.appearance ?? npc.appearance,
            outfit: update.outfit ?? npc.outfit,
            outfitHistory:
              Array.isArray(update.outfitHistory) && update.outfitHistory.length
                ? update.outfitHistory.slice(-6)
                : npc.outfitHistory || [],
          }
        : npc;
    }),
    relationships: incomingRelationships?.length ? incomingRelationships : currentState.relationships,
  };
}

function recordPipeline(snapshot, stage, details) {
  snapshot.diagnostics.pipeline = [
    {
      at: nowIso(),
      stage,
      details,
    },
    ...snapshot.diagnostics.pipeline,
  ].slice(0, 12);
  snapshot.diagnostics.updatedAt = nowIso();
}

function isDebugModeEnabled() {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch {
    return false;
  }
}

function snapshotText(snapshot) {
  return {
    phase: snapshot.storyState.phase,
    title: snapshot.storyState.title,
    objective: snapshot.storyState.currentObjective,
    pendingChoices: snapshot.storyState.pendingChoices.map((choice) => choice.label),
    world: {
      summary: snapshot.storyState.worldState.summary,
      activeForces: snapshot.storyState.worldState.activeForces,
    },
    player: {
      role: snapshot.storyState.characterState.playerProfile?.role,
      appearance: snapshot.storyState.characterState.playerProfile?.appearance,
      outfit: snapshot.storyState.characterState.playerProfile?.outfit,
      outfitHistory: snapshot.storyState.characterState.playerProfile?.outfitHistory || [],
    },
    characters: snapshot.storyState.characterState.npcs.map((npc) => ({
      name: npc.name,
      trust: npc.trust,
      status: npc.status,
      appearance: npc.appearance,
      outfit: npc.outfit,
      outfitHistory: npc.outfitHistory || [],
    })),
    plot: {
      beat: snapshot.storyState.plotState.currentBeat,
      dangerLevel: snapshot.storyState.plotState.dangerLevel,
      sceneCounter: snapshot.storyState.plotState.sceneCounter,
    },
  };
}

export async function startNewGame(snapshot) {
  snapshot.storyState = {
    ...snapshot.storyState,
    storyId: createId("story"),
    phase: "setup",
    title: "未命名故事",
    chapterId: "setup",
    sceneId: "setup-1",
    currentObjective: "先告诉我，你想进入怎样的故事。",
    setup: {
      askedFields: [],
      answers: {},
      pendingField: null,
      ready: false,
    },
    plotState: {
      ...snapshot.storyState.plotState,
      summary: "",
      premise: "",
      currentBeat: "建档开始",
      milestones: [],
      activeThreads: [],
      dangerLevel: "低",
      sceneCounter: 0,
    },
    worldState: {
      summary: "",
      rules: [],
      locations: [],
      activeForces: [],
      recentEvents: [],
    },
    characterState: {
      playerProfile: {
        role: "",
        drive: "",
        secret: "",
        appearance: "",
        outfit: "",
        outfitHistory: [],
      },
      npcs: [],
      relationships: [],
      summary: "",
    },
    pendingChoices: [],
    flags: {},
    lastTurnSummary: "",
  };
  snapshot.chatTranscript = [];
  snapshot.diagnostics.error = null;
  recordPipeline(snapshot, "master", "新游戏开始，准备进入剧情建档。");
  appendMessages(snapshot, [
    {
      type: "system",
      speakerName: "系统旁白",
      text: "主 agent 已接管流程。接下来会先由剧情 agent 逐步问你几个问题，确认这段故事的底色。",
    },
  ]);
  await continueSetup(snapshot, "");
  installTestingHooks(snapshot);
  return snapshot;
}

async function continueSetup(snapshot, playerInput) {
  const { providerConfig, agentMemories } = snapshot;
  const plotMemory = agentMemories.plot;
  const nextField = getNextSetupField(snapshot.storyState);

  if (!nextField) {
    await finalizeSetup(snapshot, buildSetupDigest(snapshot.storyState));
    return snapshot;
  }

  const setupResult = await callStructuredAgent({
    agentId: "plot.setup",
    config: providerConfig,
    memory: plotMemory,
    rolePrompt: "你是剧情控制 agent 的建档顾问。主 agent 只给你本轮要补的字段，你负责根据当前已知信息动态追问，并生成本轮选项。",
    userPrompt: buildPlotSetupPrompt(snapshot, playerInput, nextField),
    mock: async () => plotSetupMock(snapshot, playerInput, nextField),
  });

  snapshot.storyState.setup.pendingField = nextField.key;
  if (!snapshot.storyState.setup.askedFields.includes(nextField.key)) {
    snapshot.storyState.setup.askedFields.push(nextField.key);
  }

  const ackText = setupResult.ack || buildFallbackSetupAck(playerInput);
  if (ackText) {
    appendMessages(snapshot, [
      {
        type: "system",
        speakerName: "系统旁白",
        text: ackText,
      },
    ]);
  }

  snapshot.storyState.currentObjective = "继续补全世界观、剧情和角色偏好。";
  snapshot.storyState.pendingChoices = normalizeChoices(setupResult.choices);
  if (!snapshot.storyState.pendingChoices.length) {
    snapshot.storyState.pendingChoices = buildDynamicSetupChoices(nextField, snapshot.storyState);
  }
  appendMessages(snapshot, [
    {
      type: "system",
      speakerName: "系统旁白",
      text:
        setupResult.question?.text ||
        setupResult.question ||
        buildDynamicSetupQuestion(nextField, snapshot.storyState),
    },
  ]);
  recordPipeline(snapshot, "plot.setup", setupResult.summary || `建档继续收集 ${nextField.label}`);
  return snapshot;
}

async function finalizeSetup(snapshot, setupDigest) {
  const { providerConfig, agentMemories } = snapshot;
  const plotMemory = agentMemories.plot;
  snapshot.storyState.setup.ready = true;
  snapshot.storyState.setup.pendingField = null;
  snapshot.storyState.pendingChoices = [];
  appendMessages(snapshot, [
    {
      type: "system",
      speakerName: "系统旁白",
      text: "信息已经足够，我来把世界、角色和主线搭起来。",
    },
  ]);
  recordPipeline(snapshot, "plot.setup", "建档完成，开始生成世界、角色和主线。");

  const worldResult = await callStructuredAgent({
    agentId: "world.bootstrap",
    config: providerConfig,
    memory: agentMemories.world,
    rolePrompt: "你是世界控制 agent，负责输出精炼但可持续的世界设定。",
    userPrompt: buildWorldPrompt(snapshot, setupDigest),
    mock: async () => worldMock(snapshot, setupDigest),
  });
  snapshot.storyState.worldState = {
    ...snapshot.storyState.worldState,
    ...worldResult,
  };
  updateCanon(agentMemories.world, worldResult.summary);

  const characterResult = await callStructuredAgent({
    agentId: "character.bootstrap",
    config: providerConfig,
    memory: agentMemories.character,
    rolePrompt: "你是角色控制 agent，负责维护角色和关系的一致性。",
    userPrompt: buildCharacterPrompt(snapshot),
    mock: async () => characterMock(snapshot),
  });
  snapshot.storyState.characterState = {
    ...snapshot.storyState.characterState,
    ...characterResult,
  };
  updateCanon(agentMemories.character, characterResult.summary);

  const plotBlueprint = await callStructuredAgent({
    agentId: "plot.bootstrap",
    config: providerConfig,
    memory: plotMemory,
    rolePrompt: "你是剧情控制 agent，负责建立主线、关键节点，并直接写出开场草稿。",
    userPrompt: buildPlotBlueprintPrompt(snapshot),
    mock: async () => plotBlueprintMock(snapshot),
  });
  snapshot.storyState.phase = "play";
  snapshot.storyState.title = plotBlueprint.title || "未命名故事";
  snapshot.storyState.chapterId = "chapter-1";
  snapshot.storyState.sceneId = "scene-1";
  snapshot.storyState.currentObjective = plotBlueprint.openingObjective || snapshot.storyState.currentObjective;
  snapshot.storyState.plotState = {
    ...snapshot.storyState.plotState,
    premise: plotBlueprint.premise,
    summary: plotBlueprint.summary,
    currentBeat: plotBlueprint.currentBeat,
    milestones: plotBlueprint.milestones || [],
    activeThreads: plotBlueprint.activeThreads || [],
    sceneCounter: 0,
  };
  updateCanon(plotMemory, plotBlueprint.summary);
  const openingFallback = plotBlueprintMock(snapshot);
  const openingDraft = plotBlueprint.openingDraft || openingFallback.openingDraft;
  const openingChoices =
    Array.isArray(plotBlueprint.openingChoices) && plotBlueprint.openingChoices.length
      ? plotBlueprint.openingChoices
      : openingFallback.openingChoices;

  const formatOpening = runLocalFormatAgent(
    agentMemories.format,
    providerConfig,
    "format.opening",
    openingDraft,
    "剧情草稿已整理成开场消息。"
  );

  appendMessages(snapshot, formatOpening.messages || []);
  snapshot.storyState.pendingChoices = normalizeChoices(openingChoices);
  snapshot.storyState.lastTurnSummary = formatOpening.summary || "故事开始";
  recordPipeline(snapshot, "format.opening", formatOpening.summary || "完成开场格式整理。");
  installTestingHooks(snapshot);
}

function installTestingHooks(snapshot) {
  if (!isDebugModeEnabled()) {
    delete window.render_game_to_text;
    delete window.advanceTime;
    return;
  }

  window.render_game_to_text = () => JSON.stringify(snapshotText(snapshot));
  window.advanceTime = (_ms) => {
    window.dispatchEvent(new CustomEvent("wordbox:advance"));
    return snapshotText(snapshot);
  };
}

export async function submitPlayerTurn(snapshot, rawInput, options = {}) {
  const playerInput = (rawInput || "").trim();
  const playerDisplayText = (options.displayText || rawInput || "").trim();
  if (!playerInput) {
    throw new Error("请输入内容。");
  }

  if (!options.suppressPlayerEcho) {
    appendMessages(snapshot, [
      {
        type: "player",
        speakerName: "玩家",
        text: playerDisplayText || playerInput,
      },
    ]);
  }

  if (snapshot.storyState.phase === "setup") {
    const pendingField = snapshot.storyState.setup.pendingField;
    if (pendingField) {
      snapshot.storyState.setup.answers[pendingField] = playerInput;
    }
    snapshot.storyState.setup.turnCount = (snapshot.storyState.setup.turnCount || 0) + 1;
    recordPipeline(snapshot, "master", `玩家在建档阶段回答：${playerInput}`);
    await continueSetup(snapshot, playerInput);
    installTestingHooks(snapshot);
    return snapshot;
  }

  if (snapshot.storyState.phase !== "play") {
    throw new Error("当前还没有可推进的故事。");
  }

  const { providerConfig, agentMemories } = snapshot;
  recordPipeline(snapshot, "master", `收到玩家行动：${playerInput}`);

  const plotResult = await callStructuredAgent({
    agentId: "plot.turn",
    config: providerConfig,
    memory: agentMemories.plot,
    rolePrompt: "你是剧情控制 agent，先审查，再规划并直接写出本回合剧情草稿。",
    userPrompt: buildPlotTurnPrompt(snapshot, playerInput),
    mock: async () => plotTurnMock(snapshot, playerInput),
  });
  recordPipeline(snapshot, "plot.turn", plotResult.summary || "剧情规划完成。");

  const stateAgentCalls = decideStateAgentCalls(plotResult);
  recordPipeline(
    snapshot,
    "master",
    `状态判定：world=${stateAgentCalls.world.shouldUpdate ? "call" : "skip"}；character=${stateAgentCalls.character.shouldUpdate ? "call" : "skip"}`
  );

  let worldResult;
  if (stateAgentCalls.world.shouldUpdate) {
    try {
      worldResult = await callStructuredAgent({
        agentId: "world.turn",
        config: providerConfig,
        memory: agentMemories.world,
        rolePrompt: "你是世界控制 agent，负责维护世界的一致性和后果。",
        userPrompt: buildWorldUpdatePrompt(snapshot, plotResult, playerInput),
        mock: async () => worldUpdateMock(snapshot, plotResult),
      });
      updateCanon(agentMemories.world, worldResult.summary);
      recordPipeline(snapshot, "world.turn", worldResult.summary || stateAgentCalls.world.reason);
    } catch (error) {
      worldResult = buildSkippedWorldResult(snapshot, {
        reason: `世界状态更新失败，沿用上一轮记录。${error.message}`,
      });
      recordPipeline(snapshot, "world.turn", `回退：${error.message}`);
    }
  } else {
    worldResult = buildSkippedWorldResult(snapshot, stateAgentCalls.world);
    recordPipeline(snapshot, "world.turn", `跳过：${stateAgentCalls.world.reason}`);
  }

  let characterResult;
  if (stateAgentCalls.character.shouldUpdate) {
    try {
      characterResult = await callStructuredAgent({
        agentId: "character.turn",
        config: providerConfig,
        memory: agentMemories.character,
        rolePrompt: "你是角色控制 agent，负责维护人物状态和关系变化。",
        userPrompt: buildCharacterUpdatePrompt(snapshot, plotResult, playerInput),
        mock: async () => characterUpdateMock(snapshot, plotResult, playerInput),
      });
      updateCanon(agentMemories.character, characterResult.summary);
      recordPipeline(snapshot, "character.turn", characterResult.summary || stateAgentCalls.character.reason);
    } catch (error) {
      characterResult = buildSkippedCharacterResult(snapshot, {
        reason: `角色状态更新失败，沿用上一轮记录。${error.message}`,
      });
      recordPipeline(snapshot, "character.turn", `回退：${error.message}`);
    }
  } else {
    characterResult = buildSkippedCharacterResult(snapshot, stateAgentCalls.character);
    recordPipeline(snapshot, "character.turn", `跳过：${stateAgentCalls.character.reason}`);
  }

  const formatResult = runLocalFormatAgent(
    agentMemories.format,
    providerConfig,
    "format.turn",
    plotResult.draft || `系统旁白：${plotResult.plan?.sceneGoal || plotResult.summary || "场景继续推进。"}`,
    "剧情草稿已整理成本回合消息。"
  );

  snapshot.storyState.plotState.currentBeat = plotResult.plan.beat;
  snapshot.storyState.plotState.activeThreads = plotResult.stateUpdates.activeThreads || snapshot.storyState.plotState.activeThreads;
  snapshot.storyState.plotState.dangerLevel = plotResult.stateUpdates.dangerLevel || snapshot.storyState.plotState.dangerLevel;
  snapshot.storyState.plotState.sceneCounter += 1;
  snapshot.storyState.currentObjective = plotResult.stateUpdates.currentObjective || snapshot.storyState.currentObjective;
  if (!worldResult.skipped) {
    snapshot.storyState.worldState = {
      ...snapshot.storyState.worldState,
      summary: worldResult.summary,
      recentEvents: worldResult.delta.recentEvents || snapshot.storyState.worldState.recentEvents,
      locations: worldResult.delta.locations || snapshot.storyState.worldState.locations,
      activeForces: worldResult.delta.activeForces || snapshot.storyState.worldState.activeForces,
    };
  }
  if (!characterResult.skipped) {
    snapshot.storyState.characterState = mergeCharacterState(snapshot.storyState.characterState, characterResult);
  }
  snapshot.storyState.pendingChoices = normalizeChoices(plotResult.plan.choiceBlueprints);
  snapshot.storyState.lastTurnSummary = formatResult.summary || plotResult.summary;
  updateCanon(agentMemories.master, `当前目标：${snapshot.storyState.currentObjective}`);
  appendMessages(snapshot, formatResult.messages || []);
  recordPipeline(snapshot, "format.turn", formatResult.summary || "完成本回合格式整理。");
  installTestingHooks(snapshot);
  return snapshot;
}

export function getViewModel(snapshot) {
  return {
    title: snapshot.storyState.title,
    phaseLabel:
      snapshot.storyState.phase === "setup"
        ? "建档中"
        : snapshot.storyState.phase === "play"
        ? "游戏中"
        : snapshot.storyState.phase === "ended"
        ? "已结束"
        : "未开始",
    objective: snapshot.storyState.currentObjective,
    statusText: buildStatusText(snapshot.storyState),
    pendingChoices: snapshot.storyState.pendingChoices || [],
    messages: snapshot.chatTranscript,
    debugState: snapshotText(snapshot),
    debugMemories: snapshot.agentMemories,
    debugPipeline: snapshot.diagnostics.pipeline,
  };
}
