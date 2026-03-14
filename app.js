import { getViewModel, startNewGame, submitPlayerTurn } from "./agents.js";
import {
  PROVIDER_PRESETS,
  buildFreshStoryState,
  clearAppState,
  getProviderPreset,
  loadAppState,
  normalizeProviderConfig,
  normalizeUiPreferences,
  saveAppState,
} from "./storage.js";

let appState = loadAppState();
let isBusy = false;
let renderedMessageIds = new Set();
const DEBUG_MODE = new URLSearchParams(window.location.search).get("debug") === "1";
const THEME_STORAGE_KEY = "wordbox-theme-v3";
const CHOICE_CLOSE_ANIMATION_MS = 180;
const NPC_COLOR_PALETTES = [
  {
    lightBg: "rgba(255, 245, 241, 0.9)",
    lightLine: "rgba(197, 130, 110, 0.22)",
    lightSpeaker: "#a45e49",
    darkBg: "rgba(52, 34, 37, 0.94)",
    darkLine: "rgba(193, 128, 117, 0.22)",
    darkSpeaker: "#d7aa98",
  },
  {
    lightBg: "rgba(245, 250, 241, 0.9)",
    lightLine: "rgba(132, 165, 112, 0.24)",
    lightSpeaker: "#5f8451",
    darkBg: "rgba(32, 45, 37, 0.94)",
    darkLine: "rgba(138, 171, 120, 0.24)",
    darkSpeaker: "#b7d1a5",
  },
  {
    lightBg: "rgba(242, 248, 255, 0.9)",
    lightLine: "rgba(114, 145, 191, 0.22)",
    lightSpeaker: "#5372a0",
    darkBg: "rgba(31, 39, 56, 0.95)",
    darkLine: "rgba(121, 153, 202, 0.22)",
    darkSpeaker: "#adc4eb",
  },
  {
    lightBg: "rgba(250, 243, 255, 0.9)",
    lightLine: "rgba(157, 125, 188, 0.22)",
    lightSpeaker: "#835c9d",
    darkBg: "rgba(42, 33, 56, 0.95)",
    darkLine: "rgba(171, 136, 208, 0.22)",
    darkSpeaker: "#ccb4e4",
  },
  {
    lightBg: "rgba(255, 248, 238, 0.9)",
    lightLine: "rgba(198, 149, 92, 0.22)",
    lightSpeaker: "#9f6f36",
    darkBg: "rgba(54, 40, 28, 0.95)",
    darkLine: "rgba(215, 164, 103, 0.22)",
    darkSpeaker: "#ddb882",
  },
  {
    lightBg: "rgba(239, 251, 249, 0.9)",
    lightLine: "rgba(97, 159, 148, 0.24)",
    lightSpeaker: "#4c8b80",
    darkBg: "rgba(27, 47, 45, 0.94)",
    darkLine: "rgba(105, 176, 164, 0.24)",
    darkSpeaker: "#9ed1c8",
  },
];
let themeMode = loadThemeMode();

const refs = {
  appShell: document.querySelector(".app-shell"),
  settingsToggle: document.querySelector("#settingsToggle"),
  debugToggle: document.querySelector("#debugToggle"),
  storyTitle: document.querySelector("#storyTitle"),
  storyObjective: document.querySelector("#storyObjective"),
  statusText: document.querySelector("#statusText"),
  messageList: document.querySelector("#messageList"),
  messageTemplate: document.querySelector("#messageTemplate"),
  choiceTray: document.querySelector("#choiceTray"),
  choiceToggle: document.querySelector("#choiceToggle"),
  choiceToggleLabel: document.querySelector("#choiceToggleLabel"),
  choiceBar: document.querySelector("#choiceBar"),
  composer: document.querySelector("#composer"),
  playerInput: document.querySelector("#playerInput"),
  sendButton: document.querySelector("#sendButton"),
  scrim: document.querySelector("#scrim"),
  settingsDrawer: document.querySelector("#settingsDrawer"),
  debugDrawer: document.querySelector("#debugDrawer"),
  closeSettings: document.querySelector("#closeSettings"),
  closeDebug: document.querySelector("#closeDebug"),
  themeToggle: document.querySelector("#themeToggle"),
  providerPreset: document.querySelector("#providerPreset"),
  baseUrl: document.querySelector("#baseUrl"),
  apiKey: document.querySelector("#apiKey"),
  model: document.querySelector("#model"),
  temperature: document.querySelector("#temperature"),
  maxContextBudget: document.querySelector("#maxContextBudget"),
  typingSpeed: document.querySelector("#typingSpeed"),
  typingSpeedHint: document.querySelector("#typingSpeedHint"),
  saveConfigButton: document.querySelector("#saveConfigButton"),
  newGameButton: document.querySelector("#newGameButton"),
  clearSaveButton: document.querySelector("#clearSaveButton"),
  debugState: document.querySelector("#debugState"),
  debugMemories: document.querySelector("#debugMemories"),
  debugPipeline: document.querySelector("#debugPipeline"),
};

const panelState = {
  settingsOpen: false,
  debugOpen: false,
  settingsClosing: false,
  debugClosing: false,
};

const choiceUiState = {
  expanded: false,
  closing: false,
  hasUnseen: false,
  signature: "",
};

const narrationState = {
  hydrated: false,
  knownMessageIds: new Set(),
  revealedChars: new Map(),
  queue: [],
  activeMessage: null,
  timerId: null,
};

let latestViewModel = null;

bootstrap();

function bootstrap() {
  applyThemeMode();
  syncDebugMode();
  hydrateProviderOptions();
  bindEvents();
  initializeNarrationState(appState.chatTranscript);
  render();
  syncSettingsForm();
  scrollToBottom();
}

function bindEvents() {
  refs.settingsToggle.addEventListener("click", () => togglePanel("settings", true));
  if (DEBUG_MODE) {
    refs.debugToggle.addEventListener("click", () => togglePanel("debug", true));
    refs.closeDebug.addEventListener("click", () => togglePanel("debug", false));
  }
  refs.closeSettings.addEventListener("click", () => togglePanel("settings", false));
  refs.scrim.addEventListener("click", () => {
    togglePanel("settings", false);
    if (DEBUG_MODE) {
      togglePanel("debug", false);
    }
  });

  refs.providerPreset.addEventListener("change", handlePresetChange);
  refs.themeToggle.addEventListener("click", handleThemeToggle);
  refs.saveConfigButton.addEventListener("click", saveConfig);
  refs.newGameButton.addEventListener("click", handleNewGame);
  refs.clearSaveButton.addEventListener("click", handleClearSave);
  refs.typingSpeed.addEventListener("change", syncTypingSpeedHint);
  refs.composer.addEventListener("submit", handleComposerSubmit);
  refs.choiceToggle.addEventListener("click", handleChoiceToggle);
  refs.playerInput.addEventListener("input", autoResizeComposer);
  window.addEventListener("resize", () => {
    syncFloatingTrayPosition();
    scrollToBottom();
  });
}

function hydrateProviderOptions() {
  refs.providerPreset.innerHTML = "";
  for (const preset of PROVIDER_PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    refs.providerPreset.append(option);
  }
}

function handlePresetChange() {
  const preset = getProviderPreset(refs.providerPreset.value);
  if (refs.providerPreset.value !== "custom") {
    refs.baseUrl.value = preset.baseUrl;
    refs.model.value = preset.model;
  }
  if (!preset.requiresKey) {
    refs.apiKey.value = "";
  }
}

function syncSettingsForm() {
  const config = normalizeProviderConfig(appState.providerConfig);
  const uiPreferences = normalizeUiPreferences(appState.uiPreferences);
  refs.providerPreset.value = config.providerPreset;
  refs.baseUrl.value = config.baseUrl;
  refs.apiKey.value = config.apiKey;
  refs.model.value = config.model;
  refs.temperature.value = String(config.temperature);
  refs.maxContextBudget.value = String(config.maxContextBudget);
  refs.typingSpeed.value = String(uiPreferences.typingSpeed);
  syncTypingSpeedHint();
}

function syncDebugMode() {
  if (refs.debugToggle) {
    refs.debugToggle.hidden = !DEBUG_MODE;
  }
  if (!DEBUG_MODE) {
    panelState.debugOpen = false;
    if (refs.debugDrawer) {
      refs.debugDrawer.hidden = true;
    }
  }
}

function readProviderConfig() {
  return normalizeProviderConfig({
    providerPreset: refs.providerPreset.value,
    baseUrl: refs.baseUrl.value.trim(),
    apiKey: refs.apiKey.value.trim(),
    model: refs.model.value.trim(),
    temperature: refs.temperature.value,
    maxContextBudget: refs.maxContextBudget.value,
  });
}

function readUiPreferences() {
  return normalizeUiPreferences({
    typingSpeed: refs.typingSpeed.value,
  });
}

function saveConfig() {
  appState.providerConfig = readProviderConfig();
  appState.uiPreferences = readUiPreferences();
  saveAppState(appState);
  syncSettingsForm();
  renderStatus("配置已保存。");
}

async function handleNewGame() {
  if (isBusy) {
    return;
  }

  saveConfig();
  await runBusyTask("剧情建档启动中...", async () => {
    resetNarrationState();
    appState = buildFreshStoryState(appState);
    await startNewGame(appState);
    saveAppState(appState);
    togglePanel("settings", false);
  });
}

async function handleComposerSubmit(event) {
  event.preventDefault();
  if (isBusy) {
    return;
  }

  const input = refs.playerInput.value.trim();
  if (!input) {
    return;
  }

  refs.playerInput.value = "";
  autoResizeComposer();
  const rollbackChoices = consumePendingChoices();
  await runBusyTask("主 agent 正在协调剧情...", async () => {
    await submitPlayerTurn(appState, input);
    saveAppState(appState);
  }, {
    onError: rollbackChoices,
  });
}

function handleClearSave() {
  if (isBusy) {
    return;
  }

  clearAppState();
  resetNarrationState();
  appState = buildFreshStoryState({
    providerConfig: readProviderConfig(),
    uiPreferences: readUiPreferences(),
  });
  saveAppState(appState);
  syncSettingsForm();
  renderStatus("本地存档已清空。");
  render();
}

function handleChoiceToggle() {
  if (refs.choiceTray.hidden || choiceUiState.closing) {
    return;
  }

  if (choiceUiState.expanded) {
    animateChoiceBarClose();
    return;
  }

  choiceUiState.expanded = true;
  choiceUiState.hasUnseen = false;
  render();
}

function handleThemeToggle() {
  themeMode = themeMode === "dark" ? "light" : "dark";
  persistThemeMode(themeMode);
  applyThemeMode();
  render();
}

async function runBusyTask(statusText, task, options = {}) {
  isBusy = true;
  renderStatus(statusText);
  render();

  try {
    await task();
    appState.diagnostics.error = null;
    render();
    scrollToBottom();
  } catch (error) {
    console.error(error);
    if (typeof options.onError === "function") {
      options.onError();
    }
    appState.diagnostics.error = error.message;
    renderStatus(error.message);
    return false;
  } finally {
    isBusy = false;
    render();
  }

  return true;
}

function renderStatus(text) {
  refs.statusText.textContent = text;
}

function render() {
  const viewModel = getViewModel(appState);
  latestViewModel = viewModel;
  if (DEBUG_MODE) {
    window.render_game_to_text = () => JSON.stringify(viewModel.debugState);
    window.advanceTime = (_ms) => viewModel.debugState;
  } else {
    delete window.render_game_to_text;
    delete window.advanceTime;
  }
  syncNarrationState(viewModel.messages);
  const narrationAnimating = isNarrationAnimating();
  refs.storyTitle.textContent = viewModel.title || "Wordbox";
  refs.storyObjective.textContent = viewModel.objective || "通过多 Agent 搭建属于你的故事。";
  syncThemeToggle();
  if (!isBusy) {
    refs.statusText.textContent = appState.diagnostics.error || (narrationAnimating ? "内容输出中..." : viewModel.statusText);
  }

  renderMessages(viewModel.messages);
  renderChoices(viewModel.pendingChoices, { suspended: narrationAnimating });
  refs.sendButton.disabled = isBusy || narrationAnimating;
  refs.playerInput.disabled = isBusy || narrationAnimating;
  refs.statusText.classList.toggle("is-loading", isBusy);

  if (DEBUG_MODE) {
    refs.debugState.textContent = JSON.stringify(viewModel.debugState, null, 2);
    refs.debugMemories.textContent = JSON.stringify(viewModel.debugMemories, null, 2);
    refs.debugPipeline.textContent = JSON.stringify(viewModel.debugPipeline, null, 2);
  }

  const anyPanelOpen = panelState.settingsOpen || (DEBUG_MODE && panelState.debugOpen);
  const allOpenPanelsClosing = 
    (!panelState.settingsOpen || panelState.settingsClosing) && 
    (!(DEBUG_MODE && panelState.debugOpen) || panelState.debugClosing);

  refs.scrim.hidden = !anyPanelOpen;
  refs.scrim.classList.toggle("is-closing", anyPanelOpen && allOpenPanelsClosing);

  refs.settingsDrawer.hidden = !panelState.settingsOpen;
  refs.settingsDrawer.classList.toggle("is-closing", panelState.settingsClosing);

  refs.debugDrawer.hidden = !DEBUG_MODE || !panelState.debugOpen;
  refs.debugDrawer.classList.toggle("is-closing", panelState.debugClosing);
  syncFloatingTrayPosition();
}

function renderMessages(messages) {
  refs.messageList.innerHTML = "";

  const visibleMessages = messages.filter(shouldRenderMessage);

  if (!visibleMessages.length && !isBusy) {
    const empty = document.createElement("p");
    empty.className = "message-empty";
    empty.textContent = "点击“设置”，保存模型后开始新游戏。";
    refs.messageList.append(empty);
    renderedMessageIds.clear();
    return;
  }

  const newRenderedIds = new Set();
  const fragment = document.createDocumentFragment();
  for (const message of visibleMessages) {
    const node = refs.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(`message-${message.type}`);
    if (message.id) {
      if (!renderedMessageIds.has(message.id)) {
        node.classList.add("animate-in");
      }
      newRenderedIds.add(message.id);
    }
    node.querySelector(".message-speaker").textContent = message.speakerName || "";
    node.querySelector(".message-text").textContent = getDisplayedMessageText(message);
    applyMessageAccent(node, message);
    fragment.append(node);
  }

  if (isBusy) {
    const loadingNode = refs.messageTemplate.content.firstElementChild.cloneNode(true);
    loadingNode.classList.add("message-npc", "message-loading", "animate-in");
    loadingNode.querySelector(".message-speaker").textContent = "思考中...";
    loadingNode.querySelector(".message-text").innerHTML = `<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>`;
    // optionally give it the default accent
    applyMessageAccent(loadingNode, { type: "npc", speakerName: "system" });
    fragment.append(loadingNode);
  }

  renderedMessageIds = newRenderedIds;
  refs.messageList.append(fragment);
}

function shouldRenderMessage(message) {
  if (!message) {
    return false;
  }

  if (!message.id) {
    return Boolean(message.text);
  }

  if (message.type === "player") {
    return true;
  }

  const displayedText = getDisplayedMessageText(message);
  return displayedText.length > 0;
}

function applyMessageAccent(node, message) {
  if (message.type !== "npc") {
    return;
  }

  const accent = getNpcAccentPalette(message.speakerName || message.speakerId || "");
  node.style.setProperty("--npc-light-bg", accent.lightBg);
  node.style.setProperty("--npc-light-line", accent.lightLine);
  node.style.setProperty("--npc-light-speaker", accent.lightSpeaker);
  node.style.setProperty("--npc-dark-bg", accent.darkBg);
  node.style.setProperty("--npc-dark-line", accent.darkLine);
  node.style.setProperty("--npc-dark-speaker", accent.darkSpeaker);
}

function getNpcAccentPalette(speakerKey) {
  const normalized = String(speakerKey || "").trim();
  if (!normalized) {
    return NPC_COLOR_PALETTES[0];
  }

  const hash = Array.from(normalized).reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    7
  );
  return NPC_COLOR_PALETTES[hash % NPC_COLOR_PALETTES.length];
}

function renderChoices(choices, options = {}) {
  const signature = JSON.stringify(
    choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      intent: choice.intent,
      payload: choice.payload,
    }))
  );

  if (!choices.length) {
    refs.choiceBar.innerHTML = "";
    refs.choiceTray.hidden = true;
    refs.choiceBar.hidden = true;
    choiceUiState.expanded = false;
    choiceUiState.closing = false;
    choiceUiState.hasUnseen = false;
    choiceUiState.signature = "";
    refs.appShell.classList.remove("has-choice-overlay");
    syncFloatingTrayPosition();
    return;
  }

  if (signature !== choiceUiState.signature) {
    choiceUiState.signature = signature;
    choiceUiState.expanded = false;
    choiceUiState.hasUnseen = true;
  }

  refs.choiceBar.innerHTML = "";
  refs.choiceTray.hidden = Boolean(options.suspended);
  refs.choiceBar.hidden = Boolean(options.suspended) || !(choiceUiState.expanded || choiceUiState.closing);
  refs.choiceBar.classList.toggle("is-closing", choiceUiState.closing);
  refs.appShell.classList.toggle(
    "has-choice-overlay",
    !refs.choiceTray.hidden && (choiceUiState.expanded || choiceUiState.closing)
  );
  refs.choiceToggle.setAttribute("aria-expanded", String(choiceUiState.expanded));
  refs.choiceToggle.classList.toggle("is-expanded", choiceUiState.expanded || choiceUiState.closing);
  refs.choiceToggle.classList.toggle("has-attention", choiceUiState.hasUnseen);
  refs.choiceToggle.disabled = isBusy || choiceUiState.closing || Boolean(options.suspended);
  refs.choiceToggleLabel.textContent = choiceUiState.expanded
    ? "收起"
    : "选项";
  refs.choiceToggle.setAttribute(
    "aria-label",
    choiceUiState.expanded
      ? "收起选项"
      : choiceUiState.hasUnseen
      ? `展开 ${choices.length} 个新选项`
      : `展开 ${choices.length} 个选项`
  );

  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-button";
    button.disabled = isBusy;
    button.style.setProperty("--choice-delay", `${index * 42}ms`);
    button.innerHTML = `
      <span class="choice-title">${escapeHtml(choice.label)}</span>
      <span class="choice-intent">${escapeHtml(choice.intent || "点击后直接发送")}</span>
    `;
    button.addEventListener("click", async () => {
      if (isBusy || choiceUiState.closing) {
        return;
      }
      const rollbackEcho = appendOptimisticPlayerEcho(choice.label);
      choiceUiState.hasUnseen = false;
      await animateChoiceBarClose({ skipFinalRender: true });
      const choicePayload = choice.payload || choice.label;
      const rollbackChoices = consumePendingChoices();
      await runBusyTask("主 agent 正在协调剧情...", async () => {
        await submitPlayerTurn(appState, choicePayload, {
          displayText: choice.label,
          suppressPlayerEcho: true,
        });
        saveAppState(appState);
      }, {
        onError: () => {
          rollbackEcho();
          rollbackChoices();
        },
      });
    });
    refs.choiceBar.append(button);
  });
}

async function togglePanel(panel, open) {
  if (open) {
    if (panel === "settings") {
      panelState.settingsOpen = true;
      panelState.settingsClosing = false;
    }
    if (panel === "debug" && DEBUG_MODE) {
      panelState.debugOpen = true;
      panelState.debugClosing = false;
    }
    render();
  } else {
    if (panel === "settings" && panelState.settingsOpen && !panelState.settingsClosing) {
      panelState.settingsClosing = true;
      render();
      await wait(260);
      if (panelState.settingsClosing) {
        panelState.settingsOpen = false;
        panelState.settingsClosing = false;
        render();
      }
    }
    if (panel === "debug" && panelState.debugOpen && !panelState.debugClosing) {
      panelState.debugClosing = true;
      render();
      await wait(260);
      if (panelState.debugClosing) {
        panelState.debugOpen = false;
        panelState.debugClosing = false;
        render();
      }
    }
  }
}

function consumePendingChoices() {
  const previousChoices = Array.isArray(appState.storyState.pendingChoices)
    ? appState.storyState.pendingChoices.map((choice) => ({ ...choice }))
    : [];

  if (!previousChoices.length) {
    return () => {};
  }

  appState.storyState.pendingChoices = [];
  choiceUiState.expanded = false;
  choiceUiState.closing = false;
  choiceUiState.hasUnseen = false;
  choiceUiState.signature = "";
  render();

  return () => {
    appState.storyState.pendingChoices = previousChoices;
    choiceUiState.closing = false;
    choiceUiState.signature = "";
    choiceUiState.hasUnseen = true;
    render();
  };
}

function appendOptimisticPlayerEcho(text) {
  const value = String(text || "").trim();
  if (!value) {
    return () => {};
  }

  const messageId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  appState.chatTranscript = Array.isArray(appState.chatTranscript) ? appState.chatTranscript : [];
  appState.chatTranscript.push({
    id: messageId,
    type: "player",
    speakerName: "玩家",
    text: value,
  });
  render();
  scrollToBottom();

  return () => {
    const messageIndex = appState.chatTranscript.findIndex((entry) => entry.id === messageId);
    if (messageIndex >= 0) {
      appState.chatTranscript.splice(messageIndex, 1);
      render();
    }
  };
}

async function animateChoiceBarClose(options = {}) {
  if (choiceUiState.closing || !choiceUiState.expanded || refs.choiceBar.hidden) {
    choiceUiState.expanded = false;
    choiceUiState.closing = false;
    if (!options.skipFinalRender) {
      render();
    }
    return;
  }

  choiceUiState.closing = true;
  render();
  await wait(CHOICE_CLOSE_ANIMATION_MS);
  choiceUiState.expanded = false;
  choiceUiState.closing = false;
  if (!options.skipFinalRender) {
    render();
  }
}

function loadThemeMode() {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch (_error) {
    return "light";
  }
}

function persistThemeMode(mode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch (_error) {
    // Ignore storage failures and keep the in-memory preference.
  }
}

function applyThemeMode() {
  document.body.dataset.theme = themeMode;
}

function syncThemeToggle() {
  if (!refs.themeToggle) {
    return;
  }

  const isDarkMode = themeMode === "dark";
  refs.themeToggle.textContent = isDarkMode ? "日间模式" : "夜间模式";
  refs.themeToggle.classList.toggle("is-dark", isDarkMode);
  refs.themeToggle.setAttribute("aria-pressed", String(isDarkMode));
}

function syncTypingSpeedHint() {
  if (!refs.typingSpeedHint || !refs.typingSpeed) {
    return;
  }

  const typingSpeed = Number(refs.typingSpeed.value);
  let label = "标准速度";
  if (typingSpeed <= 10) {
    label = "很快";
  } else if (typingSpeed <= 14) {
    label = "较快";
  } else if (typingSpeed <= 18) {
    label = "标准";
  } else if (typingSpeed <= 24) {
    label = "舒缓";
  } else {
    label = "缓慢";
  }

  refs.typingSpeedHint.textContent = `${label}（${typingSpeed}ms / 步）`;
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function initializeNarrationState(messages = []) {
  clearNarrationTimer();
  narrationState.hydrated = true;
  narrationState.queue = [];
  narrationState.activeMessage = null;
  narrationState.knownMessageIds = new Set();
  narrationState.revealedChars = new Map();

  messages.forEach((message) => {
    if (!message?.id) {
      return;
    }
    narrationState.knownMessageIds.add(message.id);
    narrationState.revealedChars.set(message.id, (message.text || "").length);
  });
}

function resetNarrationState() {
  clearNarrationTimer();
  narrationState.hydrated = true;
  narrationState.queue = [];
  narrationState.activeMessage = null;
  narrationState.knownMessageIds = new Set();
  narrationState.revealedChars = new Map();
}

function syncNarrationState(messages = []) {
  if (!narrationState.hydrated) {
    initializeNarrationState(messages);
    return;
  }

  if (!messages.length) {
    resetNarrationState();
    return;
  }

  const visibleIds = new Set(messages.map((message) => message.id));
  if (
    narrationState.knownMessageIds.size &&
    !messages.some((message) => narrationState.knownMessageIds.has(message.id))
  ) {
    resetNarrationState();
  }

  messages.forEach((message) => {
    if (!message?.id || narrationState.knownMessageIds.has(message.id)) {
      return;
    }

    narrationState.knownMessageIds.add(message.id);
    if (message.type === "player") {
      narrationState.revealedChars.set(message.id, (message.text || "").length);
      return;
    }

    narrationState.revealedChars.set(message.id, 0);
    narrationState.queue.push(message);
  });

  Array.from(narrationState.revealedChars.keys()).forEach((messageId) => {
    if (!visibleIds.has(messageId)) {
      narrationState.revealedChars.delete(messageId);
      narrationState.knownMessageIds.delete(messageId);
    }
  });

  narrationState.queue = narrationState.queue.filter((message) => visibleIds.has(message.id));
  if (narrationState.activeMessage && !visibleIds.has(narrationState.activeMessage.id)) {
    narrationState.activeMessage = null;
    clearNarrationTimer();
  }

  if (!narrationState.activeMessage && narrationState.queue.length) {
    startNarrationAnimation();
  }
}

function startNarrationAnimation() {
  if (narrationState.activeMessage || !narrationState.queue.length) {
    return;
  }

  narrationState.activeMessage = narrationState.queue.shift();
  const result = revealNarrationStep();
  if (result === "completed" && narrationState.queue.length) {
    startNarrationAnimation();
  }
}

function scheduleNarrationTick() {
  clearNarrationTimer();
  narrationState.timerId = window.setTimeout(runNarrationTick, getTypingIntervalMs());
}

function runNarrationTick() {
  narrationState.timerId = null;
  const result = revealNarrationStep();
  if (result === "completed" && narrationState.queue.length) {
    startNarrationAnimation();
  }
}

function revealNarrationStep() {
  const activeMessage = narrationState.activeMessage;
  if (!activeMessage) {
    return "idle";
  }

  const fullText = activeMessage.text || "";
  const currentLength = narrationState.revealedChars.get(activeMessage.id) || 0;
  const nextLength = Math.min(fullText.length, currentLength + getTypewriterStep(fullText.length));
  narrationState.revealedChars.set(activeMessage.id, nextLength);
  renderMessages(latestViewModel?.messages || appState.chatTranscript || []);
  syncFloatingTrayPosition();
  scrollToBottom();

  if (nextLength >= fullText.length) {
    narrationState.activeMessage = null;
    if (!narrationState.queue.length) {
      render();
    }
    return "completed";
  }

  scheduleNarrationTick();
  return "ongoing";
}

function clearNarrationTimer() {
  if (narrationState.timerId) {
    window.clearTimeout(narrationState.timerId);
    narrationState.timerId = null;
  }
}

function isNarrationAnimating() {
  return Boolean(narrationState.activeMessage || narrationState.queue.length || narrationState.timerId);
}

function getDisplayedMessageText(message) {
  const fullText = message.text || "";
  const revealedChars = narrationState.revealedChars.get(message.id);
  return typeof revealedChars === "number" ? fullText.slice(0, revealedChars) : fullText;
}

function getTypewriterStep(textLength) {
  if (textLength > 160) {
    return 4;
  }
  if (textLength > 100) {
    return 3;
  }
  if (textLength > 48) {
    return 2;
  }
  return 1;
}

function getTypingIntervalMs() {
  return normalizeUiPreferences(appState.uiPreferences).typingSpeed;
}

function autoResizeComposer() {
  refs.playerInput.style.height = "0px";
  refs.playerInput.style.height = `${Math.min(refs.playerInput.scrollHeight, 160)}px`;
  syncFloatingTrayPosition();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    refs.messageList.scrollTop = refs.messageList.scrollHeight;
  });
}

function isMessageListNearBottom(threshold = 80) {
  if (!refs.messageList) {
    return false;
  }

  const { scrollHeight, scrollTop, clientHeight } = refs.messageList;
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

function syncFloatingTrayPosition() {
  if (!refs.appShell) {
    return;
  }

  if (!refs.choiceTray || refs.choiceTray.hidden) {
    refs.appShell.classList.remove("has-choice-overlay");
    return;
  }

  const composerHeight = refs.composer?.offsetHeight || 0;
  refs.choiceTray.style.bottom = `${composerHeight + 36}px`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
