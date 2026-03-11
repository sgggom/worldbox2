const OPENROUTER_REFERER = "https://wordbox.local";
const OPENROUTER_TITLE = "Wordbox";

export function estimateTokens(value) {
  if (!value) {
    return 0;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

export function parseJsonPayload(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("模型没有返回可解析内容。");
  }

  const candidates = buildJsonCandidates(raw);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed) {
      return parsed;
    }
  }

  throw new Error("模型返回了非 JSON 内容。");
}

function tryParse(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function buildJsonCandidates(raw) {
  const normalized = normalizeJsonLikeText(raw);
  const candidates = new Set();

  pushCandidate(candidates, normalized);

  const withoutFence = normalized
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  pushCandidate(candidates, withoutFence);

  const extracted = extractJsonBlock(normalized);
  pushCandidate(candidates, extracted);

  for (const candidate of Array.from(candidates)) {
    pushCandidate(candidates, repairJsonLikeText(candidate));
  }

  return Array.from(candidates).filter(Boolean);
}

function pushCandidate(candidates, value) {
  if (!value || typeof value !== "string") {
    return;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  candidates.add(trimmed);
}

function normalizeJsonLikeText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function repairJsonLikeText(value) {
  if (!value) {
    return value;
  }

  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/([{,]\s*)([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5-]*)(\s*:)/g, '$1"$2"$3')
    .replace(/'/g, '"')
    .replace(/，/g, ",")
    .replace(/：/g, ":")
    .replace(/；/g, ",")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function extractJsonBlock(value) {
  const startIndex = [...value].findIndex((char) => char === "{" || char === "[");
  if (startIndex < 0) {
    return "";
  }

  const openChar = value[startIndex];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === openChar) {
      depth += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(startIndex, index + 1);
      }
    }
  }

  return value.slice(startIndex);
}

export async function callOpenAiCompatible(config, messages, options = {}) {
  const baseUrl = (config.baseUrl || "").replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;

  if (!baseUrl) {
    throw new Error("缺少 Base URL。");
  }

  if (!config.apiKey) {
    throw new Error("缺少 API Key。");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };

  if (config.providerPreset === "openrouter") {
    headers["HTTP-Referer"] = OPENROUTER_REFERER;
    headers["X-Title"] = OPENROUTER_TITLE;
  }

  const controller = new AbortController();
  const promptTokens = estimateTokens(messages);
  const maxTokens = Number.isFinite(options.maxTokens) ? Math.max(200, options.maxTokens) : 900;
  const temperature = Number.isFinite(Number(options.temperature))
    ? Number(options.temperature)
    : config.temperature;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : Math.min(150000, Math.max(45000, (promptTokens + maxTokens) * 40));
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature,
        messages,
        stream: false,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage =
        payload?.error?.message ||
        payload?.message ||
        `请求失败，状态码 ${response.status}`;
      throw new Error(errorMessage);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("服务返回了空内容。");
    }

    return content;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)} 秒），请检查网络或降低模型负载。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
