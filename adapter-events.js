// Adapter native event normalization.
// Each vendor CLI speaks its own dialect on stdout; this module adapts those
// dialects into the organization's hub.* vocabulary without inventing facts:
// tool steps carry their native command/subtype, deltas are volume-tracked,
// usage never poses as progress.
const DELTA_PROGRESS_CHARS = 3000;
const DELTA_PROGRESS_MS = 30_000;

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && (item.type === "text" || typeof item.text === "string"))
    .map((item) => item.text || "")
    .join("");
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: usage.input_tokens ?? usage.inputTokens ?? usage.input ?? 0,
    cached_input_tokens:
      usage.cached_input_tokens ??
      usage.cache_read_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cacheReadTokens ??
      0,
    output_tokens: usage.output_tokens ?? usage.outputTokens ?? usage.output ?? 0,
    reasoning_tokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? usage.reasoning ?? 0,
    total_tokens: usage.total_tokens ?? usage.totalTokens ?? usage.total,
  };
}

function sessionEvent(raw, state) {
  const sessionId = raw.session_id || raw.sessionId || raw.sessionID || raw.thread_id || raw.threadId;
  if (!sessionId || sessionId === state.sessionId) return null;
  state.sessionId = sessionId;
  return { type: "hub.session", sessionId };
}

function toolDetail(raw) {
  try {
    const snapshot = JSON.stringify(raw);
    return snapshot.length > 500 ? `${snapshot.slice(0, 500)}…` : snapshot;
  } catch {
    return "";
  }
}

function trackDelta(state, text) {
  const length = typeof text === "string" ? text.length : 0;
  state.deltaChars = (state.deltaChars || 0) + length;
  const now = Date.now();
  const lastChars = state.lastDeltaProgressChars || 0;
  const lastAt = state.lastDeltaProgressAt || 0;
  if (state.deltaChars - lastChars < DELTA_PROGRESS_CHARS && now - lastAt < DELTA_PROGRESS_MS) return null;
  state.lastDeltaProgressChars = state.deltaChars;
  state.lastDeltaProgressAt = now;
  return {
    type: "hub.progress",
    message: "持续生成中",
    detail: `已接收模型输出约${state.deltaChars}字`,
  };
}

function normalizeEvent(adapter, raw, state) {
  const events = [];
  const session = sessionEvent(raw, state);
  if (session) events.push(session);

  if (raw.type === "error" || raw.type === "turn.failed" || raw.is_error === true) {
    events.push({
      type: "hub.error",
      message: raw.error?.message || raw.message || raw.result || `${adapter.label} 执行失败`,
    });
    return events;
  }

  if (adapter.id === "codex") {
    if (raw.type === "thread.started") {
      events.push({ type: "hub.progress", message: "正在分析任务" });
    } else if (raw.type === "item.started") {
      const started = raw.item?.type === "command_execution"
        ? `开始执行工具：${raw.item?.command || raw.item?.name || "命令"}`
        : "正在执行";
      events.push({ type: "hub.progress", message: started, detail: toolDetail(raw.item) });
    } else if (raw.type === "item.completed") {
      if (raw.item?.type === "agent_message" && raw.item.text) {
        events.push({ type: "hub.result", text: raw.item.text });
      } else if (raw.item?.type === "command_execution") {
        const command = raw.item?.command || raw.item?.name || "命令";
        const exit = raw.item?.exit_code ?? raw.item?.exitCode;
        events.push({
          type: "hub.progress",
          message: `工具步骤已完成：${command}${exit !== undefined && exit !== null ? `（退出码 ${exit}）` : ""}`,
          detail: toolDetail(raw.item),
        });
      }
    } else if (raw.type === "turn.completed") {
      const usage = normalizeUsage(raw.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    }
    return events;
  }

  if (adapter.id === "grok") {
    if (raw.type === "thought" && !state.thinking) {
      state.thinking = true;
      events.push({ type: "hub.progress", message: "正在推理" });
    } else if (raw.type === "text" && typeof raw.data === "string") {
      events.push({ type: "hub.delta", text: raw.data });
      const progress = trackDelta(state, raw.data);
      if (progress) events.push(progress);
    } else if (raw.type === "usage" || raw.type === "end") {
      const usage = normalizeUsage(raw.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    }
    return events;
  }

  if (adapter.id === "opencode") {
    if (raw.type === "step_start") {
      events.push({ type: "hub.progress", message: "正在分析任务" });
    } else if (raw.type === "text" && typeof raw.part?.text === "string") {
      events.push({ type: "hub.delta", text: raw.part.text });
      const progress = trackDelta(state, raw.part.text);
      if (progress) events.push(progress);
    } else if (raw.type === "step_finish") {
      const usage = normalizeUsage(raw.part?.tokens);
      if (usage) events.push({ type: "hub.usage", usage });
      if (raw.part?.reason && raw.part.reason !== "stop") {
        events.push({ type: "hub.error", message: `OpenCode 步骤结束：${raw.part.reason}` });
      }
    }
  }

  if (adapter.id === "zcode") {    if (raw.type === "model.streaming") {
      const kind = raw.payload?.kind;
      if (kind === "reasoning_start" && !state.thinking) {
        state.thinking = true;
        events.push({ type: "hub.progress", message: "正在推理" });
      } else if (kind === "text_delta" && typeof raw.payload?.delta === "string") {
        events.push({ type: "hub.delta", text: raw.payload.delta });
        const progress = trackDelta(state, raw.payload.delta);
        if (progress) events.push(progress);
      }
    } else if (raw.type === "session.updated") {
      const runtimeModel =
        typeof raw.payload?.model === "string"
          ? raw.payload.model
          : raw.payload?.model?.providerId && raw.payload?.model?.modelId
            ? `${raw.payload.model.providerId}/${raw.payload.model.modelId}`
            : "";
      if (runtimeModel && runtimeModel !== state.runtimeModel) {
        state.runtimeModel = runtimeModel;
        events.push({ type: "hub.runtime", model: runtimeModel });
      }
      const runtimeReasoning = raw.payload?.modelCall?.reasoning?.effectiveLevel;
      const runtimeReasoningBudget =
        raw.payload?.modelCall?.reasoning?.effectiveBudgetTokens;
      if (
        runtimeReasoning &&
        (runtimeReasoning !== state.runtimeReasoning ||
          runtimeReasoningBudget !== state.runtimeReasoningBudget)
      ) {
        state.runtimeReasoning = runtimeReasoning;
        state.runtimeReasoningBudget = runtimeReasoningBudget;
        events.push({
          type: "hub.runtime",
          model: state.runtimeModel,
          reasoningEffort: runtimeReasoning,
          reasoningBudgetTokens: runtimeReasoningBudget,
        });
      }
      if (typeof raw.payload?.content === "string") {
        events.push({ type: "hub.result", text: raw.payload.content });
      }
      const usage = normalizeUsage(raw.payload?.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    } else if (raw.type === "turn.completed") {
      if (typeof raw.payload?.response === "string") {
        events.push({ type: "hub.result", text: raw.payload.response });
      }
      const usage = normalizeUsage(raw.payload?.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    } else if (raw.type === "result") {
      if (typeof raw.response === "string") {
        events.push({ type: "hub.result", text: raw.response });
      }
      const usage = normalizeUsage(raw.usage);
      if (usage) events.push({ type: "hub.usage", usage });
    }
    return events;
  }

  if (raw.type === "connection" || raw.type === "retry") {
    const message = raw.subtype === "reconnecting" ? "上游连接中断，正在重连" : "正在连接上游服务";
    events.push({ type: "hub.progress", message });
  } else if (raw.type === "system" && raw.subtype === "init") {
    if (raw.model) events.push({ type: "hub.runtime", model: raw.model });
    events.push({ type: "hub.progress", message: "会话已建立" });
  } else if (raw.type === "assistant") {
    const text = contentText(raw.message?.content ?? raw.content);
    if (text) events.push({ type: "hub.result", text });
  } else if (raw.type === "result") {
    const text =
      typeof raw.result === "string"
        ? raw.result
        : contentText(raw.message?.content ?? raw.content);
    if (text) events.push({ type: "hub.result", text });
    const usage = normalizeUsage(raw.usage);
    if (usage) events.push({ type: "hub.usage", usage });
  } else if (raw.type === "text" && typeof raw.data === "string") {
    events.push({ type: "hub.delta", text: raw.data });
    const progress = trackDelta(state, raw.data);
    if (progress) events.push(progress);
  } else if (raw.type === "usage") {
    const usage = normalizeUsage(raw.usage);
    if (usage) events.push({ type: "hub.usage", usage });
  } else if (raw.type?.includes("tool")) {
    events.push({
      type: "hub.progress",
      message: `正在执行工具步骤${raw.subtype ? `（${raw.subtype}）` : ""}`,
      detail: toolDetail(raw),
    });
  }

  return events;
}

module.exports = {
  stripAnsi,
  contentText,
  normalizeUsage,
  normalizeEvent,
  DELTA_PROGRESS_CHARS,
  DELTA_PROGRESS_MS,
};
