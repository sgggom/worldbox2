const STORAGE_KEY = "wordbox-static-v1";
const DEFAULT_TYPING_SPEED = 18;

export const PROVIDER_PRESETS = [
  {
    id: "mock",
    label: "Mock Story (离线演示)",
    baseUrl: "mock://story",
    model: "wordbox-sim",
    requiresKey: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    requiresKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    requiresKey: true,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    requiresKey: true,
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-72B-Instruct",
    requiresKey: true,
  },
  {
    id: "custom",
    label: "自定义 OpenAI-Compatible",
    baseUrl: "",
    model: "",
    requiresKey: true,
  },
];

const PROVIDER_MAP = new Map(PROVIDER_PRESETS.map((item) => [item.id, item]));

function createEmptyMemory(agentId) {
  return {
    agentId,
    canonSummary: "",
    chapterSummary: "",
    recentTurns: [],
    compressions: 0,
    lastCompressedAt: null,
  };
}

export function createDefaultAppState() {
  return {
    providerConfig: {
      providerPreset: "mock",
      baseUrl: PROVIDER_MAP.get("mock").baseUrl,
      apiKey: "",
      model: PROVIDER_MAP.get("mock").model,
      temperature: 0.9,
      maxContextBudget: 12000,
      stream: false,
    },
    storyState: {
      storyId: null,
      phase: "idle",
      title: "Wordbox",
      chapterId: null,
      sceneId: null,
      currentObjective: "通过多 Agent 搭建属于你的故事。",
      setup: {
        askedFields: [],
        answers: {},
        pendingField: null,
        ready: false,
        turnCount: 0,
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
      plotState: {
        premise: "",
        summary: "",
        currentBeat: "",
        milestones: [],
        activeThreads: [],
        dangerLevel: "低",
        sceneCounter: 0,
      },
      pendingChoices: [],
      flags: {},
      lastTurnSummary: "",
    },
    agentMemories: {
      master: createEmptyMemory("master"),
      plot: createEmptyMemory("plot"),
      world: createEmptyMemory("world"),
      character: createEmptyMemory("character"),
      format: createEmptyMemory("format"),
    },
    chatTranscript: [],
    diagnostics: {
      pipeline: [],
      error: null,
      updatedAt: null,
    },
    uiPreferences: {
      typingSpeed: DEFAULT_TYPING_SPEED,
    },
  };
}

export function getProviderPreset(presetId) {
  return PROVIDER_MAP.get(presetId) ?? PROVIDER_MAP.get("custom");
}

export function normalizeProviderConfig(config) {
  const preset = getProviderPreset(config.providerPreset);
  return {
    providerPreset: config.providerPreset || "mock",
    baseUrl: config.baseUrl || preset.baseUrl,
    apiKey: config.apiKey || "",
    model: config.model || preset.model,
    temperature: Number.isFinite(Number(config.temperature))
      ? Number(config.temperature)
      : 0.9,
    maxContextBudget: Number.isFinite(Number(config.maxContextBudget))
      ? Number(config.maxContextBudget)
      : 12000,
    stream: Boolean(config.stream),
  };
}

export function normalizeUiPreferences(preferences = {}) {
  const typingSpeed = Number(preferences.typingSpeed);
  return {
    typingSpeed: Number.isFinite(typingSpeed)
      ? Math.min(40, Math.max(8, typingSpeed))
      : DEFAULT_TYPING_SPEED,
  };
}

export function loadAppState() {
  const fallback = createDefaultAppState();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw);
    const parsedAgentMemories = parsed.agentMemories || {};
    const migratedFormatMemory =
      parsedAgentMemories.format ||
      parsedAgentMemories.writer ||
      fallback.agentMemories.format;

    return {
      ...fallback,
      ...parsed,
      providerConfig: normalizeProviderConfig({
        ...fallback.providerConfig,
        ...(parsed.providerConfig || {}),
      }),
      storyState: {
        ...fallback.storyState,
        ...(parsed.storyState || {}),
        setup: {
          ...fallback.storyState.setup,
          ...(parsed.storyState?.setup || {}),
        },
        worldState: {
          ...fallback.storyState.worldState,
          ...(parsed.storyState?.worldState || {}),
        },
        characterState: {
          ...fallback.storyState.characterState,
          ...(parsed.storyState?.characterState || {}),
        },
        plotState: {
          ...fallback.storyState.plotState,
          ...(parsed.storyState?.plotState || {}),
        },
      },
      agentMemories: {
        ...fallback.agentMemories,
        ...parsedAgentMemories,
        format: {
          ...fallback.agentMemories.format,
          ...(migratedFormatMemory || {}),
          agentId: "format",
        },
      },
      diagnostics: {
        ...fallback.diagnostics,
        ...(parsed.diagnostics || {}),
      },
      uiPreferences: normalizeUiPreferences({
        ...fallback.uiPreferences,
        ...(parsed.uiPreferences || {}),
      }),
      chatTranscript: Array.isArray(parsed.chatTranscript)
        ? parsed.chatTranscript
        : fallback.chatTranscript,
    };
  } catch (error) {
    console.warn("Failed to load local save", error);
    return fallback;
  }
}

export function saveAppState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearAppState() {
  localStorage.removeItem(STORAGE_KEY);
}

export function buildFreshStoryState(existingState) {
  const fallback = createDefaultAppState();
  return {
    ...fallback,
    providerConfig: normalizeProviderConfig(existingState.providerConfig),
    uiPreferences: normalizeUiPreferences(existingState.uiPreferences),
  };
}
