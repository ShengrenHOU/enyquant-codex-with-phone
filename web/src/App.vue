<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import ChatView from "./components/ChatView.vue";
import LoginView from "./components/LoginView.vue";
import SessionListView from "./components/SessionListView.vue";
import { request, requestHistoricalSessionsPage, requestHistoryMessages, requestMobileHome, requestSessionById } from "./lib/api.js";
import { normalizeServerPayload } from "./lib/normalize-events.js";
import {
  PREVIEW_FALLBACK,
  compactLine,
  createMessage,
  fallbackPreviewForSession,
  fallbackTitleForSession,
  filterTerminalNoise,
  formatRelativeTime,
  normalizeHistoryMessages,
  normalizeLine,
  sanitizeAssistantText,
  wait,
  workspaceName
} from "./lib/session-helpers.js";

const composerDraft = ref("");
const router = useRouter();
const route = useRoute();
const historyApiAvailable = ref(null);
const sessionCache = reactive({});
const pendingHydrations = new Map();
const TOKEN_STORAGE_KEY = "codex-web-terminal.saved-token";
let autoLoginTried = false;
let replaySuppressionLines = new Set();
let submitFallbackTimer = null;
let reconnectTimer = null;
let lastHomeVisibleRefreshAt = 0;

const CONNECTION_IDLE = "idle";
const CONNECTION_CONNECTING = "connecting";
const CONNECTION_SENDING = "sending";
const CONNECTION_STREAMING = "streaming";
const CONNECTION_RECONNECTING = "reconnecting";
const CONNECTION_DISCONNECTED = "disconnected";
const MAX_RECONNECT_ATTEMPTS = 3;
const HOME_REFRESH_COOLDOWN_MS = 1500;
const WAITING_STATUS_TEXTS = new Set(["等待 Codex 回复…", "等待首个响应…", "Codex 正在思考…", "上下文较重，仍在准备首个响应…", "正在发送…", "正在生成回复…"]);

const LIVE_BOOTSTRAP_LINE_PATTERNS = [
  /^[╭╰│─]+$/,
  /^>_?\s*OpenAI Codex/i,
  /^model:\s/i,
  /^directory:\s/i,
  /^Tip:\s/i,
  /^⚠\s*Skipped loading/i,
  /^\[Image #\d+\]/i,
  /^›\s?/,
  /^\[[;?0-9a-zA-Z]+\]$/,
  /\/model to change/i,
  /Use the OpenAI docs MCP/i,
  /available skills/i,
  /dangerously-bypass-approv/i,
  /approvals-and-sandbox/i
];

const state = reactive({
  ready: false,
  isAuthenticated: false,
  loading: false,
  homeLoading: false,
  viewLoading: false,
  accessToken: "",
  rememberToken: true,
  statusText: "",
  sessions: [],
  liveSessions: [],
  continueSession: null,
  defaultCreateCwd: "",
  createTargetCwd: "",
  createModalOpen: false,
  createDraftName: "",
  historyPage: {
    limit: 5,
    offset: 0,
    returned: 0,
    total: 0,
    hasMore: false
  },
  loadingMoreHistory: false,
  activeSessionId: "",
  activeLiveSessionId: "",
  activeSessionMeta: null,
  activeMessages: [],
  activeSocket: null,
  activeStreamBuffer: "",
  connectionState: CONNECTION_IDLE,
  turnActive: false,
  turnCompletedAt: 0,
  reconnectAttempts: 0,
  reconnectInFlight: false,
  pendingSessionId: "",
  activeSessionOpenToken: 0,
  replayGuardActive: false,
  replayGuardPrompt: "",
  replayGuardUntil: 0,
  lastSubmitText: "",
  lastSubmitAt: 0,
  backendHttpOrigin: "",
  backendWsOrigin: ""
});
let syncingRouteOpen = false;

function cacheKey(session) {
  return session?.kind === "history"
    ? `history:${session.provider}:${session.resumeSessionId}`
    : `live:${session?.id || "unknown"}`;
}

function parseHistoryRouteSessionId(value) {
  const text = String(value || "").trim();
  const match = text.match(/^history:([^:]+):(.+)$/i);
  if (!match) {
    return null;
  }
  const provider = String(match[1] || "").trim().toLowerCase();
  const resumeSessionId = String(match[2] || "").trim();
  if (!provider || !resumeSessionId) {
    return null;
  }
  return { provider, resumeSessionId };
}

function decorateSession(session) {
  const cache = sessionCache[cacheKey(session)] || {};
  const cachedTitle = String(cache.title || "").trim();
  const rawName = String(session?.name || "").trim();
  let displayTitle = cachedTitle;

  if (!displayTitle) {
    if (session?.autoNamed && !String(session?.inputPreview || "").trim()) {
      displayTitle = session?.resumeSessionId ? fallbackTitleForSession({ ...session, name: "" }) : "新会话";
    } else if (rawName) {
      displayTitle = rawName;
    } else {
      displayTitle = fallbackTitleForSession(session);
    }
  }

  return {
    ...session,
    displayTitle,
    displayPreview: cache.preview || fallbackPreviewForSession(session),
    groupName: workspaceName(session.cwd)
  };
}

const continueSessionItem = computed(() => (state.continueSession ? decorateSession(state.continueSession) : null));
const defaultCreateWorkspaceName = computed(() => workspaceName(state.createTargetCwd || state.defaultCreateCwd || ""));
const canSubmitCreate = computed(() => state.pendingSessionId !== "__creating__");

function mergeSessionsById(existingSessions, incomingSessions) {
  const byId = new Map();
  for (const session of existingSessions || []) {
    if (session?.id) {
      byId.set(session.id, session);
    }
  }
  for (const session of incomingSessions || []) {
    if (session?.id) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

const groupedSessions = computed(() => {
  const sessionSorter = (left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt));
  const groups = new Map();
  for (const session of state.sessions.map(decorateSession)) {
    if (String(session?.sessionType || "").trim().toLowerCase() === "subagent") {
      continue;
    }
    if (!groups.has(session.groupName)) {
      groups.set(session.groupName, []);
    }
    groups.get(session.groupName).push(session);
  }

  return [...groups.entries()]
    .map(([name, sessions]) => ({
      name,
      cwd: sessions[0]?.cwd || "",
      sessions: [...sessions].sort(sessionSorter)
    }))
    .sort((left, right) =>
      String(right.sessions[0]?.updatedAt || "").localeCompare(String(left.sessions[0]?.updatedAt || ""))
    );
});

const activeSessionTitle = computed(() => {
  if (!state.activeSessionMeta) {
    return "会话";
  }
  const cached = sessionCache[cacheKey(state.activeSessionMeta)] || {};
  return cached.title || state.activeSessionMeta.displayTitle || state.activeSessionMeta.name || "会话";
});

const activeWorkspaceName = computed(() => workspaceName(state.activeSessionMeta?.cwd || ""));
const activeAssistantName = computed(() => state.activeSessionMeta?.providerLabel || "Codex");
const routeHistoryTarget = computed(() => {
  if (route.name !== "chat") {
    return null;
  }
  return parseHistoryRouteSessionId(route.params.sessionId);
});
const expectedThreadId = computed(() => {
  const target = routeHistoryTarget.value;
  if (!target || target.provider !== "codex") {
    return "";
  }
  return target.resumeSessionId;
});
const activeThreadId = computed(() => String(state.activeSessionMeta?.resumeSessionId || "").trim());
const threadMismatch = computed(() => {
  if (!expectedThreadId.value) {
    return false;
  }
  if (!activeThreadId.value) {
    return false;
  }
  return expectedThreadId.value !== activeThreadId.value;
});
const showSharedThreadHint = computed(() => {
  if (threadMismatch.value) {
    return true;
  }
  if (!expectedThreadId.value || !activeThreadId.value) {
    return false;
  }
  return Boolean(state.activeLiveSessionId) && activeThreadId.value === expectedThreadId.value;
});
const connectionLabel = computed(() => {
  switch (state.connectionState) {
    case CONNECTION_CONNECTING:
      return "正在连接";
    case CONNECTION_SENDING:
      return state.statusText && WAITING_STATUS_TEXTS.has(state.statusText) ? state.statusText : "消息已发送，等待响应";
    case CONNECTION_STREAMING:
      return "正在接收回复";
    case CONNECTION_RECONNECTING:
      return "正在恢复连接";
    case CONNECTION_DISCONNECTED:
      return "连接已断开";
    default:
      return "";
  }
});
const canReconnectActiveSession = computed(() => {
  return Boolean(state.activeLiveSessionId) && state.connectionState === CONNECTION_DISCONNECTED;
});
const sessionNoticeText = computed(() => {
  const text = String(state.statusText || "").trim();
  if (!text) {
    return "";
  }
  if (WAITING_STATUS_TEXTS.has(text) || text === "本轮回复已结束。") {
    return "";
  }
  return text;
});
const canSend = computed(() => Boolean(composerDraft.value.trim()));
const canInterrupt = computed(() => {
  const socketReady =
    Boolean(state.activeLiveSessionId) &&
    Boolean(state.activeSocket) &&
    state.activeSocket.readyState === WebSocket.OPEN;
  if (!socketReady) {
    return false;
  }
  if (state.loading) {
    return true;
  }
  if (state.turnActive) {
    return true;
  }
  if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
    return true;
  }
  if (String(state.activeStreamBuffer || "").trim()) {
    return true;
  }
  const lastMessage = state.activeMessages[state.activeMessages.length - 1];
  return Boolean(lastMessage?.role === "assistant" && lastMessage?.streaming);
});

function setStatus(message = "") {
  state.statusText = message;
}

function clearSubmitFallbackTimer() {
  if (submitFallbackTimer) {
    window.clearTimeout(submitFallbackTimer);
    submitFallbackTimer = null;
  }
}

function schedulePendingReplyProgression() {
  clearSubmitFallbackTimer();
  submitFallbackTimer = window.setTimeout(() => {
    if (state.connectionState !== CONNECTION_SENDING || state.statusText !== "等待首个响应…") {
      submitFallbackTimer = null;
      return;
    }
    setStatus("Codex 正在思考…");
    submitFallbackTimer = window.setTimeout(() => {
      if (state.connectionState === CONNECTION_SENDING && state.statusText === "Codex 正在思考…") {
        setStatus("上下文较重，仍在准备首个响应…");
      }
      submitFallbackTimer = null;
    }, 2600);
  }, 1200);
}

function setConnectionState(nextState) {
  state.connectionState = nextState || CONNECTION_IDLE;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function resetConnectionRecovery() {
  clearReconnectTimer();
  state.reconnectAttempts = 0;
  state.reconnectInFlight = false;
}

function toFriendlyLoginError(error) {
  const message = String(error?.message || error || "").trim();
  if (!message) {
    return "登录失败，请重试。";
  }
  if (/unauthorized/i.test(message)) {
    return "token 不正确，请检查后重试。";
  }
  if (/client address is not allowed/i.test(message)) {
    return "当前访问地址未被允许，请确认网络方式是否正确。";
  }
  return message;
}

function detectSystemFailureText(value) {
  const text = normalizeLine(value || "");
  if (!text) {
    return "";
  }

  if (/missing optional dependency\s+@openai\/codex-/i.test(text)) {
    return "Codex CLI 启动失败：本机缺少必要依赖，请检查安装环境。";
  }
  if (/\bzsh:\s*command not found\b/i.test(text) || /command not found/i.test(text)) {
    return "Codex CLI 启动失败：命令不可用，请检查本机安装与 PATH。";
  }
  if (/cannot find module|module_not_found/i.test(text)) {
    return "Codex CLI 启动失败：运行依赖缺失，请检查本机安装。";
  }
  if (/permission denied/i.test(text)) {
    return "Codex CLI 启动失败：权限不足，请检查当前环境权限。";
  }
  return "";
}

function isDisposableAssistantFragment(value) {
  const text = normalizeLine(value || "");
  if (!text) {
    return true;
  }
  return /^[=~`._-]{1,8}$/.test(text);
}

function getSavedToken() {
  if (typeof window === "undefined") {
    return "";
  }
  return String(window.localStorage.getItem(TOKEN_STORAGE_KEY) || "").trim();
}

function saveTokenPreference(token) {
  if (typeof window === "undefined") {
    return;
  }
  if (state.rememberToken && token) {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

function setMessages(messages) {
  state.activeMessages = messages.filter((message) => message?.text);
  rebuildReplaySuppressionLines(state.activeMessages);
}

function bumpActiveSessionOpenToken() {
  state.activeSessionOpenToken += 1;
}

function rebuildReplaySuppressionLines(messages) {
  replaySuppressionLines = new Set();
  for (const message of messages || []) {
    const lines = String(message?.text || "")
      .split("\n")
      .map((line) => compactLine(line))
      .filter(Boolean);
    for (const line of lines) {
      replaySuppressionLines.add(line);
    }
  }
}

function pruneLiveBootstrapNoise(value) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const filtered = lines.filter((line) => {
    const compact = compactLine(line);
    if (!compact) {
      return false;
    }
    if (LIVE_BOOTSTRAP_LINE_PATTERNS.some((pattern) => pattern.test(compact))) {
      return false;
    }
    if (/[\u2500-\u257f]/.test(compact) && compact.length < 120) {
      return false;
    }
    if (/[\[\];?]m/.test(compact) || /\?25h/.test(compact)) {
      return false;
    }
    if (replaySuppressionLines.has(compact)) {
      return false;
    }
    return true;
  });

  return filtered.join("\n").trim();
}

function pruneMessagePartNoise(value) {
  const lines = String(value || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const filtered = lines.filter((line) => {
    const compact = compactLine(line);
    if (!compact) {
      return false;
    }
    if (/^[\u2500-\u257f\s]+$/.test(compact)) {
      return false;
    }
    if (
      /openai codex|^model:|^directory:|new try the codex app|\/feedback|conversation interrupted|esc to interrupt/i.test(
        compact
      )
    ) {
      return false;
    }
    return true;
  });

  return filtered.join("\n").trim();
}

function finalizeAssistantStream() {
  if (!state.activeStreamBuffer) {
    return;
  }
  const messages = [...state.activeMessages];
  const last = messages[messages.length - 1];
  if (last?.streaming) {
    last.streaming = false;
    last.text = sanitizeAssistantText(normalizeLine(last.text));
    if (!last.text) {
      messages.pop();
    }
    state.activeMessages = messages;
  }
  state.activeStreamBuffer = "";
  if (state.activeLiveSessionId && state.connectionState === CONNECTION_STREAMING) {
    setConnectionState(CONNECTION_CONNECTED);
  }
}

function handleTurnStatus(payload = {}) {
  const status = String(payload?.status || "").trim().toLowerCase();
  if (!status) {
    return;
  }

  if (status === "running") {
    state.turnActive = true;
    state.turnCompletedAt = 0;
    if (state.connectionState !== CONNECTION_STREAMING) {
      setConnectionState(CONNECTION_SENDING);
      if (!WAITING_STATUS_TEXTS.has(state.statusText)) {
        setStatus("正在生成回复…");
      }
    }
    return;
  }

  if (status === "completed") {
    state.turnActive = false;
    state.turnCompletedAt = Date.now();
    clearSubmitFallbackTimer();
    finalizeAssistantStream();
    if (state.connectionState !== CONNECTION_DISCONNECTED && state.connectionState !== CONNECTION_RECONNECTING) {
      setConnectionState(CONNECTION_CONNECTED);
    }
    if (state.statusText === "已发送中断指令。") {
      setStatus("当前流程已中断。");
      return;
    }
    const errorText = String(payload?.error || "").trim();
    if (errorText) {
      setStatus(errorText);
      return;
    }
    setStatus("本轮回复已结束。");
  }
}

function discardPendingAssistantStream() {
  state.activeStreamBuffer = "";
  const messages = [...state.activeMessages];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.streaming) {
    messages.pop();
    state.activeMessages = messages;
  }
}

function appendAssistantChunk(chunk, { source = "normalized" } = {}) {
  clearSubmitFallbackTimer();
  const now = Date.now();
  if (state.replayGuardActive && now >= state.replayGuardUntil) {
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
  }

  let normalized = "";
  if (source === "message_part") {
    normalized = pruneMessagePartNoise(normalizeLine(chunk || ""));
  } else {
    // 旧 `data` 通道保留原有清洗，兼容历史行为。
    normalized = pruneLiveBootstrapNoise(filterTerminalNoise(chunk || ""));
  }
  if (!normalized) {
    return;
  }

  if (state.replayGuardActive) {
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
  }

  const systemFailure = detectSystemFailureText(normalized);
  if (systemFailure) {
    discardPendingAssistantStream();
    setStatus(systemFailure);
    return;
  }

  if (state.statusText === "等待 Codex 回复…") {
    setStatus("");
  }

  state.activeStreamBuffer += normalized;
  let mergedText = sanitizeAssistantText(normalizeLine(state.activeStreamBuffer));
  const lastUserMessage = [...state.activeMessages].reverse().find((message) => message.role === "user")?.text || "";
  if (lastUserMessage && mergedText.startsWith(lastUserMessage)) {
    const tail = mergedText.slice(lastUserMessage.length).trim();
    if (!tail || /^[>›)\]}\-_=:.~|/\\\dA-Za-z]{1,24}$/.test(tail)) {
      mergedText = "";
      state.activeStreamBuffer = "";
    }
  }
  if (!mergedText || isDisposableAssistantFragment(mergedText)) {
    if (isDisposableAssistantFragment(mergedText)) {
      discardPendingAssistantStream();
    }
    return;
  }

  const messages = [...state.activeMessages];
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && last.streaming) {
    last.text = mergedText;
  } else {
    messages.push(
      createMessage("assistant", mergedText, new Date().toISOString(), {
        streaming: true,
        source: "live"
      })
    );
  }
  state.activeMessages = messages;
}

function appendNormalizedParts(parts = []) {
  clearSubmitFallbackTimer();
  if (!Array.isArray(parts) || parts.length === 0) {
    return;
  }

  let messages = [...state.activeMessages];
  let touched = false;
  let hasStreamingUpdate = false;

  for (const part of parts) {
    const partType = String(part?.partType || "").trim();
    const role = part?.role === "user" ? "user" : part?.role === "assistant" ? "assistant" : "system";
    const ts = part?.ts || new Date().toISOString();
    const phase = String(part?.phase || "final");
    const payload = part?.payload || {};

    if (partType === "markdown" || partType === "text") {
      const text = sanitizeAssistantText(normalizeLine(String(payload.text || "")));
      if (!text) {
        continue;
      }
      if (role === "assistant" && phase === "streaming") {
        appendAssistantChunk(text, { source: part?.source || "normalized" });
        touched = true;
        hasStreamingUpdate = true;
        continue;
      }
      if (role === "assistant") {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage?.role === "assistant" && lastMessage?.streaming) {
          lastMessage.text = text;
          lastMessage.streaming = false;
          touched = true;
          continue;
        }
        if (lastMessage?.role === "assistant" && normalizeLine(String(lastMessage.text || "")) === text) {
          continue;
        }
      }
      messages.push(
        createMessage(role, text, ts, {
          source: part?.source || "normalized",
          partType,
          payload,
          rawType: part?.rawType || ""
        })
      );
      touched = true;
      continue;
    }

    if (partType === "image") {
      const url = String(payload.url || "").trim();
      if (!url) {
        continue;
      }
      const alt = String(payload.alt || "image").trim() || "image";
      finalizeAssistantStream();
      messages.push(
        createMessage(role, `![${alt}](${url})`, ts, {
          source: part?.source || "normalized",
          partType: "image",
          payload: { url, alt },
          rawType: part?.rawType || ""
        })
      );
      touched = true;
      continue;
    }

    if (partType === "error") {
      const errorText = sanitizeAssistantText(
        normalizeLine(String(payload.message || payload.text || "系统事件，请稍后重试。"))
      );
      if (!errorText) {
        continue;
      }
      messages.push(
        createMessage("system", errorText, ts, {
          source: part?.source || "normalized",
          partType,
          payload,
          rawType: part?.rawType || ""
        })
      );
      touched = true;
    }
  }

  if (touched) {
    // Streaming chunks mutate `state.activeMessages` in appendAssistantChunk.
    // If we always overwrite with the stale local `messages`, live text disappears until refresh.
    if (hasStreamingUpdate) {
      messages = [...state.activeMessages];
    }
    state.activeMessages = messages;
  }
}

function clearPendingReplyStatus() {
  if (WAITING_STATUS_TEXTS.has(state.statusText)) {
    setStatus("");
  }
}

async function hydrateSession(session, { includeMessages = false, silent = false } = {}) {
  if (!session || session.kind !== "history" || !session.resumeSessionId) {
    return null;
  }

  const key = cacheKey(session);
  const cached = sessionCache[key];
  if (cached?.hydrated && (!includeMessages || cached.messages)) {
    return cached;
  }

  if (pendingHydrations.has(key)) {
    if (!includeMessages) {
      return cached || null;
    }
    while (pendingHydrations.has(key)) {
      await wait(80);
    }
    return sessionCache[key] || null;
  }

  const task = (async () => {
    const payload = await requestHistoryMessages(session, historyApiAvailable);
    if (!payload) {
      const nextValue = {
        hydrated: true,
        title: String(session?.name || fallbackTitleForSession(session)).trim() || fallbackTitleForSession(session),
        preview: String(session?.inputPreview || fallbackPreviewForSession(session)).trim() || fallbackPreviewForSession(session),
        messages: [],
        session: null
      };
      sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
      return sessionCache[key];
    }

    const messages = normalizeHistoryMessages(payload.messages || []);
    const title = String(payload.session?.name || session.name || fallbackTitleForSession(session)).trim() || fallbackTitleForSession(session);
    const preview = String(payload.session?.inputPreview || session.inputPreview || fallbackPreviewForSession(session)).trim() || fallbackPreviewForSession(session);
    const nextValue = { hydrated: true, title, preview, messages, session: payload.session || null };
    sessionCache[key] = { ...(sessionCache[key] || {}), ...nextValue };
    return sessionCache[key];
  })();

  pendingHydrations.set(key, task);
  try {
    return await task;
  } catch (error) {
    if (!silent) {
      setStatus(error.message || String(error));
    }
    return sessionCache[key] || null;
  } finally {
    pendingHydrations.delete(key);
  }
}

async function refreshSessions() {
  state.homeLoading = true;
  try {
    const payload = await requestMobileHome({ recentLimit: 5 });
    const sessions = payload.recentSessions || [];
    const liveSessions = payload.liveSessions || [];
    const continueSession = payload.continueSession || null;
    for (const session of [...liveSessions, continueSession, ...sessions].filter(Boolean)) {
      const key = cacheKey(session);
      const title = String(session?.name || "").trim();
      if (!title) {
        continue;
      }
      sessionCache[key] = {
        ...(sessionCache[key] || {}),
        title
      };
    }
    state.liveSessions = liveSessions;
    state.continueSession = continueSession;
    state.defaultCreateCwd = String(payload?.defaultCreateCwd || continueSession?.cwd || sessions[0]?.cwd || "").trim();
    state.sessions = sessions;
    state.historyPage = {
      limit: Number(payload?.historyPage?.limit || 5),
      offset: Number(payload?.historyPage?.offset || 0),
      returned: Number(payload?.historyPage?.returned || 0),
      total: Number(payload?.historyPage?.total || 0),
      hasMore: Boolean(payload?.historyPage?.hasMore)
    };
  } finally {
    state.homeLoading = false;
  }
}

async function loadMoreHistoricalSessions() {
  if (state.loadingMoreHistory || !state.historyPage?.hasMore) {
    return;
  }

  try {
    state.loadingMoreHistory = true;
    const nextOffset = Number(state.historyPage.offset || 0) + Number(state.historyPage.returned || 0);
    const payload = await requestHistoricalSessionsPage({
      offset: nextOffset,
      limit: state.historyPage.limit || 10
    });
    const incomingSessions = payload.sessions || [];
    for (const session of incomingSessions) {
      const key = cacheKey(session);
      const title = String(session?.name || "").trim();
      if (!title) {
        continue;
      }
      sessionCache[key] = {
        ...(sessionCache[key] || {}),
        title
      };
    }
  state.sessions = mergeSessionsById(state.sessions, incomingSessions);
    state.historyPage = {
      limit: Number(payload?.page?.limit || state.historyPage.limit || 10),
      offset: Number(payload?.page?.offset || nextOffset),
      returned: Number(payload?.page?.returned || 0),
      total: Number(payload?.page?.total || state.historyPage.total || 0),
      hasMore: Boolean(payload?.page?.hasMore)
    };
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    state.loadingMoreHistory = false;
  }
}

function openCreateModal(targetCwd = "") {
  state.createDraftName = "";
  state.createTargetCwd = String(targetCwd || state.defaultCreateCwd || "").trim();
  state.createModalOpen = true;
}

function closeCreateModal() {
  if (state.pendingSessionId === "__creating__") {
    return;
  }
  state.createModalOpen = false;
  state.createTargetCwd = "";
  state.createDraftName = "";
}

function toOriginProtocol(proto) {
  return String(proto || "").toLowerCase() === "https:" ? "https:" : "http:";
}

function toWsProtocol(proto) {
  return String(proto || "").toLowerCase() === "https:" ? "wss:" : "ws:";
}

function normalizeBackendHost(rawHost) {
  const host = String(rawHost || "").trim();
  if (!host || host === "0.0.0.0" || host === "::") {
    return window.location.hostname || "localhost";
  }
  if (host === "::1") {
    return "localhost";
  }
  return host;
}

function applyBackendConfig(payload) {
  const host = normalizeBackendHost(payload?.host);
  const port = Number(payload?.port || 0);
  if (!host || !port) {
    return;
  }
  const httpProtocol = toOriginProtocol(window.location.protocol);
  const wsProtocol = toWsProtocol(window.location.protocol);
  state.backendHttpOrigin = `${httpProtocol}//${host}:${port}`;
  state.backendWsOrigin = `${wsProtocol}//${host}:${port}`;
}

function resolveWsUrl(sessionId) {
  const wsBase = String(state.backendWsOrigin || "").trim();
  if (wsBase) {
    return `${wsBase}/ws?sessionId=${encodeURIComponent(sessionId)}`;
  }
  const protocol = toWsProtocol(window.location.protocol);
  return `${protocol}//${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

async function bootstrapWorkspace({ includeSessions = true } = {}) {
  const configPayload = await request("/api/config");
  applyBackendConfig(configPayload);
  if (includeSessions) {
    await refreshSessions();
  }
}

async function handleLogin({ silent = false, auto = false } = {}) {
  const token = state.accessToken.trim();
  try {
    state.loading = true;
    if (!token) {
      throw new Error("请输入 token");
    }

    await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ token })
    });
    saveTokenPreference(token);
    state.isAuthenticated = true;
    state.accessToken = "";
    setStatus("");
    await bootstrapWorkspace();
    if (route.name === "login") {
      const redirectPath = String(route.query.redirect || "").trim();
      if (redirectPath) {
        await router.replace(redirectPath);
      } else {
        await router.replace({ name: "sessions" });
      }
    }
  } catch (error) {
    if (auto) {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
      state.rememberToken = false;
      state.accessToken = "";
      setStatus("已保存的 token 已失效，请重新输入一次。");
      return;
    }
    if (!silent) {
      setStatus(toFriendlyLoginError(error));
    }
  } finally {
    state.loading = false;
  }
}

function closeSocket() {
  clearReconnectTimer();
  clearSubmitFallbackTimer();
  if (state.activeSocket) {
    state.activeSocket.__expectedClose = true;
    state.activeSocket.close();
    state.activeSocket = null;
  }
}

function waitForSocketOpen(socket, timeoutMs = 4000) {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("会话连接还没准备好，请重试一次"));
    }, timeoutMs);

    function cleanup() {
      window.clearTimeout(timer);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
    }

    function handleOpen() {
      cleanup();
      resolve();
    }

    function handleError() {
      cleanup();
      reject(new Error("会话连接失败，请重试一次"));
    }

    function handleClose() {
      cleanup();
      reject(new Error("会话连接已关闭，请重试一次"));
    }

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("error", handleError, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
  });
}

function shouldAutoReconnectSocket(socket) {
  if (!socket || socket.__expectedClose) {
    return false;
  }
  if (route.name !== "chat") {
    return false;
  }
  if (!state.activeLiveSessionId || !state.activeSessionMeta) {
    return false;
  }
  return (
    state.activeSessionMeta.kind === "live" &&
    String(socket.__sessionId || "").trim() === String(state.activeLiveSessionId || "").trim()
  );
}

async function reconnectActiveSocket({ immediate = false } = {}) {
  if (!state.activeLiveSessionId || state.reconnectInFlight) {
    return;
  }

  clearReconnectTimer();
  state.reconnectInFlight = true;
  state.reconnectAttempts += 1;
  setConnectionState(CONNECTION_RECONNECTING);
  setStatus("正在恢复连接…");

  try {
    await attachLiveSocket(state.activeLiveSessionId, state.activeMessages, { reconnecting: true });
    resetConnectionRecovery();
    setConnectionState(CONNECTION_CONNECTED);
    if (state.loading) {
      setConnectionState(CONNECTION_SENDING);
      setStatus("等待 Codex 回复…");
    } else if (!String(state.activeStreamBuffer || "").trim()) {
      setStatus("");
    }
  } catch (error) {
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      state.reconnectInFlight = false;
      setConnectionState(CONNECTION_DISCONNECTED);
      setStatus(error?.message || "连接已断开，请重试。");
      return;
    }
    const delay = immediate ? 480 : Math.min(3200, 600 * 2 ** (state.reconnectAttempts - 1));
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectActiveSocket();
    }, delay);
  } finally {
    if (state.connectionState !== CONNECTION_DISCONNECTED) {
      state.reconnectInFlight = false;
    }
  }
}

function scheduleSocketReconnect() {
  if (state.reconnectInFlight || reconnectTimer || !state.activeLiveSessionId) {
    return;
  }
  setConnectionState(CONNECTION_RECONNECTING);
  setStatus("正在恢复连接…");
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    reconnectActiveSocket();
  }, 480);
}

function attachLiveSocket(sessionId, historyMessages = [], { reconnecting = false } = {}) {
  closeSocket();
  finalizeAssistantStream();
  state.activeLiveSessionId = sessionId;
  state.activeStreamBuffer = "";
  const socket = new WebSocket(resolveWsUrl(sessionId));
  socket.__expectedClose = false;
  socket.__sessionId = sessionId;
  state.activeSocket = socket;
  if (!reconnecting) {
    resetConnectionRecovery();
  }
  setConnectionState(reconnecting ? CONNECTION_RECONNECTING : CONNECTION_CONNECTING);

  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    if (payload.type === "snapshot") {
      if (Array.isArray(historyMessages) && historyMessages.length > 0) {
        return;
      }
      const snapshotBuffer = String(payload?.buffer || "");
      const normalizedSnapshot = sanitizeAssistantText(
        normalizeLine(snapshotBuffer.length > 12000 ? snapshotBuffer.slice(-12000) : snapshotBuffer)
      );
      if (normalizedSnapshot) {
        const lastAssistant = [...state.activeMessages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (normalizeLine(String(lastAssistant?.text || "")) !== normalizedSnapshot) {
          setMessages([
            ...state.activeMessages,
            createMessage("assistant", normalizedSnapshot, new Date().toISOString(), {
              source: "snapshot"
            })
          ]);
        }
      }
      return;
    }

    if (payload.type === "session_updated" && payload.session) {
      const updated = decorateSession(payload.session);
      state.activeSessionMeta = updated;
      if (state.activeSessionId === updated.id) {
        state.activeLiveSessionId = updated.id;
      }
      const liveIndex = state.liveSessions.findIndex((item) => item.id === updated.id);
      if (liveIndex >= 0) {
        const nextLive = [...state.liveSessions];
        nextLive[liveIndex] = updated;
        state.liveSessions = nextLive;
      }
      const index = state.sessions.findIndex((item) => item.id === updated.id);
      if (index >= 0) {
        const next = [...state.sessions];
        next[index] = updated;
        state.sessions = next;
      }
      if (state.continueSession?.id === updated.id) {
        state.continueSession = updated;
      }
      return;
    }

    if (payload.type === "turn_status") {
      handleTurnStatus(payload);
      return;
    }

    if (payload.type === "data") {
      if (payload.data && String(payload.data).trim()) {
        clearPendingReplyStatus();
        setConnectionState(CONNECTION_STREAMING);
      }
      appendNormalizedParts(normalizeServerPayload(payload, state.activeSessionId));
      return;
    }

    if (payload.type === "message_part") {
      const partPhase = String(payload?.phase || "").trim().toLowerCase();
      if (payload?.part?.type === "text" && String(payload?.part?.text || "").trim()) {
        clearPendingReplyStatus();
        if (partPhase === "streaming" || !partPhase) {
          setConnectionState(CONNECTION_STREAMING);
        }
      }
      appendNormalizedParts(normalizeServerPayload(payload, state.activeSessionId));
      return;
    }

    if (payload.type === "event_msg") {
      appendNormalizedParts(normalizeServerPayload(payload, state.activeSessionId));
      return;
    }

    if (payload.type === "error") {
      const errorText = String(payload.error || "会话发生未知错误。").trim();
      clearPendingReplyStatus();
      setConnectionState(CONNECTION_DISCONNECTED);
      appendNormalizedParts([
        {
          role: "system",
          partType: "text",
          payload: { text: errorText },
          ts: new Date().toISOString(),
          phase: "final",
          source: "ws_error",
          rawType: "error"
        }
      ]);
      setStatus(errorText);
      return;
    }

    if (payload.type === "exit") {
      finalizeAssistantStream();
      state.turnActive = false;
      setConnectionState(CONNECTION_CONNECTED);
      const exitCode = Number(payload.exitCode ?? 0);
      if (state.statusText === "已发送中断指令。") {
        setStatus("当前流程已中断。");
        return;
      }
      if (state.statusText === "等待 Codex 回复…" || state.statusText === "正在发送…") {
        setStatus(exitCode === 0 ? "本轮回复已结束。" : `Codex 会话异常退出（${exitCode}），请重试一次。`);
        return;
      }
      if (exitCode !== 0) {
        setStatus(`Codex 会话异常退出（${exitCode}），请重试一次。`);
      }
    }
  });

  socket.addEventListener("close", () => {
    if (state.activeSocket === socket) {
      state.activeSocket = null;
    }
    finalizeAssistantStream();
    if (socket.__expectedClose) {
      return;
    }
    if (state.statusText === "已发送中断指令。") {
      resetConnectionRecovery();
      setConnectionState(CONNECTION_CONNECTED);
      setStatus("当前流程已中断。");
      return;
    }
    if (shouldAutoReconnectSocket(socket)) {
      scheduleSocketReconnect();
      return;
    }
    setConnectionState(CONNECTION_DISCONNECTED);
    if (WAITING_STATUS_TEXTS.has(state.statusText)) {
      setStatus("连接已断开，请重试。");
    }
  });

  socket.addEventListener("error", () => {
    if (shouldAutoReconnectSocket(socket)) {
      scheduleSocketReconnect();
      return;
    }
    setConnectionState(CONNECTION_DISCONNECTED);
    if (WAITING_STATUS_TEXTS.has(state.statusText)) {
      setStatus("连接失败，请重试。");
    }
  });

  return waitForSocketOpen(socket).then(() => {
    setConnectionState(CONNECTION_CONNECTED);
  });
}

async function openLiveSession(session, { skipRoute = false } = {}) {
  state.pendingSessionId = session.id;
  state.viewLoading = true;
  state.turnActive = false;
  state.turnCompletedAt = 0;
  setStatus("正在连接会话…");
  try {
    state.activeSessionId = session.id;
    const decorated = decorateSession(session);
    state.activeSessionMeta = decorated;
    bumpActiveSessionOpenToken();
    if (!skipRoute && route.name !== "chat") {
      await router.push({ name: "chat", params: { sessionId: session.id } });
    }
    composerDraft.value = "";
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
    const hydratePromise = session.resumeSessionId
      ? hydrateSession(
          {
            ...session,
            id: `history:${session.provider}:${session.resumeSessionId}`,
            kind: "history",
            status: "saved"
          },
          { includeMessages: true, silent: true }
        )
      : Promise.resolve(null);
    const bootstrapPromise =
      state.backendHttpOrigin && state.backendWsOrigin
        ? Promise.resolve()
        : bootstrapWorkspace({ includeSessions: false });
    const [, hydrated] = await Promise.all([bootstrapPromise, hydratePromise]);
    const historyMessages = hydrated?.messages || [];
    if (hydrated?.session) {
      state.activeSessionMeta = {
        ...state.activeSessionMeta,
        displayTitle: hydrated.title || state.activeSessionMeta.displayTitle,
        displayPreview: hydrated.preview || state.activeSessionMeta.displayPreview,
        cwd: hydrated.session.cwd || state.activeSessionMeta.cwd || ""
      };
    }
    setMessages(historyMessages);
    await attachLiveSocket(session.id, historyMessages);
    setStatus("");
  } finally {
    state.pendingSessionId = "";
    state.viewLoading = false;
  }
}

async function openHistoricalSession(session, { skipRoute = false } = {}) {
  closeSocket();
  resetConnectionRecovery();
  setConnectionState(CONNECTION_IDLE);
  state.turnActive = false;
  state.turnCompletedAt = 0;
  finalizeAssistantStream();
  state.pendingSessionId = session.id;
  state.viewLoading = true;
  setStatus("正在加载会话…");
  try {
    const decorated = decorateSession(session);
    const hydrated = await hydrateSession(session, { includeMessages: true });
    const historyMessages = hydrated?.messages || [];

    state.activeSessionId = session.id;
    state.activeSessionMeta = {
      ...decorated,
      cwd: hydrated?.session?.cwd || decorated.cwd || "",
      displayTitle: hydrated?.title || decorated.displayTitle,
      displayPreview: hydrated?.preview || decorated.displayPreview
    };
    bumpActiveSessionOpenToken();
    if (!skipRoute && route.name !== "chat") {
      await router.push({ name: "chat", params: { sessionId: session.id } });
    }
    composerDraft.value = "";
    state.replayGuardActive = false;
    state.replayGuardPrompt = "";
    state.replayGuardUntil = 0;
    setMessages(historyMessages);
    state.activeLiveSessionId = "";
    setStatus("");
  } finally {
    state.pendingSessionId = "";
    state.viewLoading = false;
  }
}

async function openSessionItem(session, { skipRoute = false } = {}) {
  try {
    if (session.kind === "history") {
      const historySession =
        session.kind === "history"
          ? session
          : {
              ...session,
              id: `history:${session.provider}:${session.resumeSessionId}`,
              kind: "history",
              status: "saved"
            };
      await openHistoricalSession(historySession, { skipRoute });
      return;
    }
    await openLiveSession(session, { skipRoute });
  } catch (error) {
    state.viewLoading = false;
    if (session.kind === "live" && session.resumeSessionId) {
      try {
        await openHistoricalSession({
          ...session,
          id: `history:${session.provider}:${session.resumeSessionId}`,
          kind: "history",
          status: "saved"
        }, { skipRoute });
        setStatus("已切换到该会话的历史记录。");
        return;
      } catch {
        // Fall through to the original error below.
      }
    }
    state.pendingSessionId = "";
    setStatus(error.message || String(error));
  }
}

async function createSessionInGroup(group) {
  const cwd = String(group?.cwd || "").trim();
  if (cwd) {
    openCreateModal(cwd);
    return;
  }
  if (!cwd) {
    setStatus("该分组目录不可用，无法新增会话。");
    return;
  }

  try {
    state.pendingSessionId = "__creating__";
    setStatus("正在创建会话…");
    const payload = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        provider: "codex",
        cwd
      })
    });
    await refreshSessions();
    if (payload?.session) {
      await openSessionItem(payload.session);
      return;
    }
    setStatus("会话已创建，请手动打开。");
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    if (state.pendingSessionId === "__creating__") {
      state.pendingSessionId = "";
    }
  }
}

async function createQuickSession() {
  openCreateModal(state.defaultCreateCwd);
}

async function submitCreateSession() {
  const fallbackCwd = String(state.createTargetCwd || state.defaultCreateCwd || "").trim();
  const draftName = String(state.createDraftName || "").trim();

  try {
    state.pendingSessionId = "__creating__";
    setStatus("正在创建会话…");
    const payload = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        provider: "codex",
        cwd: fallbackCwd,
        name: draftName
      })
    });
    await refreshSessions();
    if (payload?.session) {
      closeCreateModal();
      await openSessionItem(payload.session);
      return;
    }
    setStatus("会话已创建，请手动打开。");
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    if (state.pendingSessionId === "__creating__") {
      state.pendingSessionId = "";
    }
  }
}

async function ensureLiveSession() {
  if (state.activeLiveSessionId && state.activeSocket && state.activeSocket.readyState === WebSocket.OPEN) {
    return state.activeLiveSessionId;
  }
  if (!state.activeSessionMeta) {
    throw new Error("当前没有可继续的会话");
  }

  if (state.activeSessionMeta.kind === "live") {
    await attachLiveSocket(state.activeSessionMeta.id, []);
    return state.activeSessionMeta.id;
  }

  const resumeSessionId = String(state.activeSessionMeta.resumeSessionId || "").trim();
  const provider = String(state.activeSessionMeta.provider || "").trim().toLowerCase();
  if (resumeSessionId && provider) {
    const reusable = state.liveSessions
      .filter(
        (session) =>
          session.kind === "live" &&
          session.status !== "exited" &&
          String(session.provider || "").trim().toLowerCase() === provider &&
          String(session.resumeSessionId || "").trim() === resumeSessionId
      )
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
    if (reusable) {
      state.activeSessionMeta = decorateSession(reusable);
      state.activeLiveSessionId = reusable.id;
      await attachLiveSocket(reusable.id, state.activeMessages);
      return reusable.id;
    }
  }

  const resumed = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      provider: state.activeSessionMeta.provider,
      cwd: state.activeSessionMeta.cwd,
      name: state.activeSessionMeta.displayTitle || state.activeSessionMeta.name,
      resumeSessionId: state.activeSessionMeta.resumeSessionId
    })
  });

  state.activeSessionMeta = {
    ...state.activeSessionMeta,
    id: resumed.session.id,
    kind: "live",
    status: resumed.session.status,
    updatedAt: resumed.session.updatedAt
  };
  state.activeLiveSessionId = resumed.session.id;
  refreshSessions().catch(() => {});
  await attachLiveSocket(resumed.session.id, state.activeMessages);
  setStatus("共享会话已连接，准备发送…");
  state.replayGuardActive = true;
  state.replayGuardUntil = Date.now() + 12_000;
  return resumed.session.id;
}

async function submitInput() {
  if (!canSend.value || state.loading) {
    return;
  }
  const text = composerDraft.value.trim();
  if (!text) {
    return;
  }
  const now = Date.now();
  if (text === state.lastSubmitText && now - Number(state.lastSubmitAt || 0) < 2500) {
    return;
  }
  state.lastSubmitText = text;
  state.lastSubmitAt = now;

  try {
    state.loading = true;
    state.turnActive = true;
    state.turnCompletedAt = 0;
    setConnectionState(CONNECTION_SENDING);
    setStatus("正在发送…");
    if (expectedThreadId.value && activeThreadId.value && expectedThreadId.value !== activeThreadId.value) {
      throw new Error(
        `会话线程不一致：当前=${activeThreadId.value}，目标=${expectedThreadId.value}。请返回列表后重新打开该会话。`
      );
    }
    await ensureLiveSession();
    if (!state.activeSocket || state.activeSocket.readyState !== WebSocket.OPEN) {
      throw new Error("会话连接还没准备好，请重试一次");
    }
    if (expectedThreadId.value && activeThreadId.value && expectedThreadId.value !== activeThreadId.value) {
      throw new Error(
        `会话线程不一致：当前=${activeThreadId.value}，目标=${expectedThreadId.value}。已取消发送，避免写入错误会话。`
      );
    }
    finalizeAssistantStream();
    state.activeSocket.send(JSON.stringify({ type: "input", data: `${text}\n` }));
    clearSubmitFallbackTimer();
    if (state.replayGuardActive) {
      state.replayGuardPrompt = text;
    }
    rebuildReplaySuppressionLines([...state.activeMessages, createMessage("user", text, new Date().toISOString())]);
    setMessages([
      ...state.activeMessages,
      createMessage("user", text, new Date().toISOString(), { source: "draft" })
    ]);
    composerDraft.value = "";
    setStatus("等待首个响应…");
    schedulePendingReplyProgression();
  } catch (error) {
    state.turnActive = false;
    if (state.activeLiveSessionId) {
      setConnectionState(CONNECTION_DISCONNECTED);
    }
    setStatus(error.message || String(error));
  } finally {
    state.loading = false;
  }
}

function interruptActiveSession() {
  clearSubmitFallbackTimer();
  if (!state.activeSocket || state.activeSocket.readyState !== WebSocket.OPEN) {
    setStatus("当前没有可中断的运行流程。");
    return;
  }

  try {
    state.activeSocket.send(JSON.stringify({ type: "input", data: "\u001b" }));
    setStatus("已发送中断指令。");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function handleManualReconnect() {
  if (!state.activeLiveSessionId) {
    return;
  }
  state.reconnectAttempts = 0;
  try {
    await reconnectActiveSocket({ immediate: true });
  } catch (error) {
    setStatus(error?.message || String(error));
  }
}

async function handleVisibilityRecovery() {
  if (!state.isAuthenticated || typeof document === "undefined" || document.visibilityState !== "visible") {
    return;
  }

  if (route.name === "sessions") {
    const now = Date.now();
    if (now - lastHomeVisibleRefreshAt < HOME_REFRESH_COOLDOWN_MS) {
      return;
    }
    lastHomeVisibleRefreshAt = now;
    try {
      await refreshSessions();
    } catch (error) {
      setStatus(error?.message || String(error));
    }
    return;
  }

  if (
    route.name === "chat" &&
    state.activeLiveSessionId &&
    (!state.activeSocket || state.activeSocket.readyState !== WebSocket.OPEN)
  ) {
    state.reconnectAttempts = 0;
    await reconnectActiveSocket({ immediate: true });
  }
}

function handleVisibilityChange() {
  handleVisibilityRecovery().catch((error) => {
    setStatus(error?.message || String(error));
  });
}

function handleBrowserOnline() {
  handleVisibilityRecovery().catch((error) => {
    setStatus(error?.message || String(error));
  });
}

async function backToList() {
  clearSubmitFallbackTimer();
  closeSocket();
  resetConnectionRecovery();
  setConnectionState(CONNECTION_IDLE);
  state.turnActive = false;
  state.turnCompletedAt = 0;
  finalizeAssistantStream();
  state.replayGuardActive = false;
  state.replayGuardPrompt = "";
  state.replayGuardUntil = 0;
  state.activeSessionId = "";
  state.activeLiveSessionId = "";
  state.activeSessionMeta = null;
  state.liveSessions = [];
  state.continueSession = null;
  state.defaultCreateCwd = "";
  state.createModalOpen = false;
  state.createDraftName = "";
  composerDraft.value = "";
  setStatus("");
  setMessages([]);
  if (route.name !== "sessions") {
    await router.push({ name: "sessions" });
  }
  await refreshSessions();
}

function defaultPreview(session) {
  return PREVIEW_FALLBACK[session?.kind] || "继续这个会话";
}

watch(
  () => route.name,
  async (name) => {
    if (name === "sessions") {
      closeSocket();
      resetConnectionRecovery();
      setConnectionState(CONNECTION_IDLE);
      finalizeAssistantStream();
      if (state.isAuthenticated) {
        try {
          await refreshSessions();
        } catch (error) {
          setStatus(error?.message || String(error));
        }
      }
    }
  }
);

watch(
  () => [state.ready, state.isAuthenticated, route.name, route.params.sessionId],
  async ([ready, isAuthenticated, routeName, routeSessionId]) => {
    if (!ready) {
      return;
    }

    if (!isAuthenticated) {
      if (routeName !== "login") {
        const redirect = route.fullPath || "/sessions";
        await router.replace({ name: "login", query: { redirect } });
      }
      return;
    }

    if (routeName === "login") {
      const redirectPath = String(route.query.redirect || "").trim();
      if (redirectPath) {
        await router.replace(redirectPath);
      } else {
        await router.replace({ name: "sessions" });
      }
      return;
    }

    if (routeName !== "chat") {
      return;
    }

  const targetSessionId = String(routeSessionId || "").trim();
  if (!targetSessionId) {
    await router.replace({ name: "sessions" });
    return;
  }

  if (syncingRouteOpen || state.activeSessionId === targetSessionId) {
    return;
  }

  const historyTarget = parseHistoryRouteSessionId(targetSessionId);
  if (historyTarget) {
    syncingRouteOpen = true;
    try {
      await openHistoricalSession(
        {
          id: targetSessionId,
          kind: "history",
          status: "saved",
          provider: historyTarget.provider,
          resumeSessionId: historyTarget.resumeSessionId,
          name: "历史会话",
          cwd: state.activeSessionMeta?.cwd || ""
        },
        { skipRoute: true }
      );
    } catch (error) {
      state.pendingSessionId = "";
      state.viewLoading = false;
      setStatus(error?.message || String(error));
      await router.replace({ name: "sessions" });
    } finally {
      syncingRouteOpen = false;
    }
    return;
  }

    let session = state.sessions.find((item) => item.id === targetSessionId);
    if (!session) {
      try {
        const single = await requestSessionById(targetSessionId);
        if (single) {
          session = single;
        }
      } catch {
        // Keep existing state when single-session lookup fails.
      }
    }

  if (!session) {
    setStatus("会话 ID 已失效，无法定位历史记录。请使用 history:provider:resumeSessionId 形式的链接。");
    await router.replace({ name: "sessions" });
    return;
  }

    syncingRouteOpen = true;
    try {
      await openSessionItem(session, { skipRoute: true });
    } finally {
      syncingRouteOpen = false;
    }
  },
  { immediate: true }
);

onMounted(async () => {
  if (typeof window !== "undefined") {
    window.addEventListener("online", handleBrowserOnline, { passive: true });
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibilityChange, { passive: true });
  }
  try {
    const savedToken = getSavedToken();
    if (savedToken) {
      state.accessToken = savedToken;
      state.rememberToken = true;
    }
    await bootstrapWorkspace({ includeSessions: route.name !== "chat" });
    state.isAuthenticated = true;
  } catch {
    state.isAuthenticated = false;
    const savedToken = getSavedToken();
    if (savedToken && !autoLoginTried) {
      autoLoginTried = true;
      state.accessToken = savedToken;
      await handleLogin({ auto: true });
    }
  } finally {
    state.ready = true;
  }
});

onBeforeUnmount(() => {
  closeSocket();
  resetConnectionRecovery();
  if (typeof window !== "undefined") {
    window.removeEventListener("online", handleBrowserOnline);
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
});

if (typeof window !== 'undefined') {
  window.__codexWebDebug = {
    state,
    groupedSessions,
    composerDraft
  };
}
</script>

<template>
  <div class="app-shell">
    <div v-if="!state.ready" class="splash-screen">
      <div class="splash-card">正在加载会话…</div>
    </div>

    <LoginView
      v-else-if="!state.isAuthenticated"
      v-model="state.accessToken"
      v-model:remember-token="state.rememberToken"
      :loading="state.loading"
      :status-text="state.statusText"
      @submit="handleLogin"
    />

    <template v-else>
      <Transition name="page-shell" mode="out-in">
      <section v-if="route.name === 'sessions'" class="mobile-shell" key="sessions">
        <header class="mobile-header list">
          <div class="header-copy">
            <h1>会话</h1>
          </div>
        </header>

        <SessionListView
          :continue-session="continueSessionItem"
          :groups="groupedSessions"
          :active-session-id="state.activeSessionId"
          :pending-session-id="state.pendingSessionId"
          :history-page="state.historyPage"
          :home-loading="state.homeLoading"
          :loading-more-history="state.loadingMoreHistory"
          :default-create-workspace-name="defaultCreateWorkspaceName"
          :format-relative-time="formatRelativeTime"
          @open="openSessionItem"
          @create-group-session="createSessionInGroup"
          @create-quick-session="createQuickSession"
          @load-more-history="loadMoreHistoricalSessions"
        />

        <div v-if="state.createModalOpen" class="create-modal-backdrop" @click="closeCreateModal">
          <section class="create-modal-card" @click.stop>
            <p class="create-modal-kicker">新建会话</p>
            <h2 class="create-modal-title">为这个会话起个名字</h2>
            <p class="create-modal-subtitle">当前默认创建到：{{ defaultCreateWorkspaceName }}</p>
            <input
              v-model="state.createDraftName"
              class="create-modal-input"
              type="text"
              placeholder="例如：欧洲论坛页面优化"
              :disabled="!canSubmitCreate"
              @keydown.enter.prevent="submitCreateSession"
            />
            <div class="create-modal-actions">
              <button type="button" class="create-modal-btn secondary" :disabled="!canSubmitCreate" @click="closeCreateModal">
                取消
              </button>
              <button type="button" class="create-modal-btn primary" :disabled="!canSubmitCreate" @click="submitCreateSession">
                {{ state.pendingSessionId === "__creating__" ? "创建中..." : "创建并进入" }}
              </button>
            </div>
          </section>
        </div>

        <div v-if="sessionNoticeText" class="notice-strip">{{ sessionNoticeText }}</div>
      </section>

      <ChatView
        v-else-if="route.name === 'chat' && state.activeSessionMeta"
        :key="`chat:${state.activeSessionMeta?.resumeSessionId || state.activeSessionMeta?.id || ''}`"
        :session-key="state.activeSessionMeta?.resumeSessionId || state.activeSessionMeta?.id || ''"
        :open-token="state.activeSessionOpenToken"
        :title="activeSessionTitle"
        :thread-id="activeThreadId"
        :expected-thread-id="expectedThreadId"
        :show-shared-thread-hint="showSharedThreadHint"
        :thread-mismatch="threadMismatch"
        :connection-state="state.connectionState"
        :connection-label="connectionLabel"
        :can-reconnect="canReconnectActiveSession"
        :turn-completed-at="state.turnCompletedAt"
        :workspace-name="activeWorkspaceName"
        :assistant-name="activeAssistantName"
        :messages="state.activeMessages"
        v-model:draft="composerDraft"
        :can-send="canSend"
        :can-interrupt="canInterrupt"
        :loading="state.loading"
        :view-loading="state.viewLoading"
        :status-text="state.statusText"
        @back="backToList"
        @interrupt="interruptActiveSession"
        @reconnect="handleManualReconnect"
        @submit="submitInput"
      />

      <section v-else class="mobile-shell centered-shell" key="loading-shell">
        <div class="splash-card">正在加载会话页面…</div>
      </section>
      </Transition>
    </template>
  </div>
</template>
