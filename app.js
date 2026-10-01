const ENDPOINT = "https://iqdttxdowvdxszxbiwua.supabase.co/functions/v1/telegram-auto-reply";
const SESSION_KEY = "arb_admin_secret";

const $ = (id) => document.getElementById(id);
const state = { secret: sessionStorage.getItem(SESSION_KEY) || "", rules: [], status: null, logs: [] };

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

async function api(admin, { method = "GET", body } = {}) {
  const res = await fetch(`${ENDPOINT}?admin=${encodeURIComponent(admin)}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-admin-secret": state.secret,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: "invalid_response" }));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function setUnlocked(unlocked) {
  $("unlockView").classList.toggle("hidden", unlocked);
  $("dashboardView").classList.toggle("hidden", !unlocked);
}

function statusText(value) {
  return value ? "Yes" : "No";
}

function formatTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const bot = s.bot || {};
  const webhook = s.webhook || {};
  const registered = Boolean(webhook.url);

  $("botIdentity").textContent = bot.username ? `@${bot.username}` : (bot.first_name || "Telegram bot");
  $("statRules").textContent = s.stats?.rules ?? 0;
  $("statSeen").textContent = s.stats?.seen_chats ?? 0;
  $("statReplies").textContent = s.stats?.replies ?? 0;

  $("globalToggle").checked = Boolean(s.auto_reply_enabled);
  $("autoReplyText").textContent = s.auto_reply_enabled ? "ON" : "OFF";

  $("statusBot").textContent = bot.username ? `@${bot.username}` : (bot.first_name || "Unknown");
  $("statusBusiness").textContent = statusText(bot.can_connect_to_business);
  $("statusWebhook").textContent = registered ? "Registered" : "Not registered";
  $("statusPending").textContent = webhook.pending_update_count ?? 0;
  $("statusError").textContent = webhook.last_error_message || "None";

  $("statusDot").className = `dot ${registered ? "good" : "bad"}`;
  $("connectionTitle").textContent = registered ? "Telegram webhook connected" : "Webhook not registered";
  $("connectionDetail").textContent = registered
    ? `Receiving updates at the Supabase Edge Function.`
    : "Register the webhook to begin receiving Telegram Business messages.";

  $("registerWebhookBtn").textContent = registered ? "Re-register webhook" : "Register webhook";
}

function labelForRule(rule) {
  const labels = {
    exact: "Exact",
    contains: "Contains",
    starts_with: "Starts with",
    ends_with: "Ends with",
    new_chat: "New messenger",
    default: "Default",
  };
  return labels[rule.match_type] || rule.match_type;
}

function renderRules() {
  const list = $("rulesList");
  $("ruleCountBadge").textContent = state.rules.length;
  if (!state.rules.length) {
    list.innerHTML = '<div class="empty">No rules yet. Add your first rule above.</div>';
    return;
  }

  list.innerHTML = state.rules.map((r) => {
    const trigger = ["new_chat", "default"].includes(r.match_type)
      ? (r.match_type === "new_chat" ? "First message from a new person" : "When no earlier rule matches")
      : (r.trigger_text || "(empty)");
    return `
      <article class="rule-item ${r.enabled ? "" : "rule-off"}">
        <div class="rule-top">
          <div>
            <div class="rule-type">${escapeHtml(labelForRule(r))}</div>
            <div class="rule-trigger">${escapeHtml(trigger)}</div>
            <div class="rule-reply">${escapeHtml(r.reply_text)}</div>
            <div class="rule-meta">
              <span>Priority ${Number(r.priority)}</span>
              <span>•</span>
              <span>${r.enabled ? "Enabled" : "Disabled"}</span>
            </div>
          </div>
          <div class="rule-actions">
            <button onclick="toggleRule(${r.id}, ${!r.enabled})">${r.enabled ? "Disable" : "Enable"}</button>
            <button onclick="editRule(${r.id})">Edit</button>
            <button class="delete" onclick="deleteRule(${r.id})">Delete</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderLogs() {
  const list = $("logsList");
  if (!state.logs.length) {
    list.innerHTML = '<div class="empty">No reply history yet.</div>';
    return;
  }
  list.innerHTML = state.logs.map((log) => `
    <article class="log-item">
      <div class="log-in">Incoming: ${escapeHtml(log.incoming_text || "(no text)")}</div>
      <div class="log-out">↳ ${escapeHtml(log.reply_text || "")}</div>
      <div class="log-time">${escapeHtml(formatTime(log.created_at))}</div>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadAll() {
  const [status, rules, logs] = await Promise.all([
    api("status"),
    api("rules"),
    api("logs"),
  ]);
  state.status = status;
  state.rules = rules.rules || [];
  state.logs = logs.logs || [];
  renderStatus();
  renderRules();
  renderLogs();
}

function updateTriggerVisibility() {
  const type = $("matchType").value;
  $("triggerWrap").classList.toggle("hidden", ["new_chat", "default"].includes(type));
}

function resetRuleForm() {
  $("editingRuleId").value = "";
  $("ruleFormTitle").textContent = "Add a reply rule";
  $("saveRuleBtn").textContent = "Add rule";
  $("cancelEditBtn").classList.add("hidden");
  $("matchType").value = "exact";
  $("priority").value = "100";
  $("triggerText").value = "";
  $("replyText").value = "";
  $("ruleEnabled").checked = true;
  $("ruleFormError").classList.add("hidden");
  updateTriggerVisibility();
}

window.editRule = function(id) {
  const rule = state.rules.find((r) => Number(r.id) === Number(id));
  if (!rule) return;
  $("editingRuleId").value = rule.id;
  $("ruleFormTitle").textContent = "Edit reply rule";
  $("saveRuleBtn").textContent = "Save changes";
  $("cancelEditBtn").classList.remove("hidden");
  $("matchType").value = rule.match_type;
  $("priority").value = rule.priority;
  $("triggerText").value = rule.trigger_text || "";
  $("replyText").value = rule.reply_text || "";
  $("ruleEnabled").checked = Boolean(rule.enabled);
  updateTriggerVisibility();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.toggleRule = async function(id, enabled) {
  try {
    await api("rule", { method: "POST", body: { action: "toggle", id, enabled } });
    toast(enabled ? "Rule enabled" : "Rule disabled");
    await loadAll();
  } catch (e) { toast(`Failed: ${e.message}`); }
};

window.deleteRule = async function(id) {
  if (!confirm("Delete this auto-reply rule?")) return;
  try {
    await api("rule", { method: "POST", body: { action: "delete", id } });
    toast("Rule deleted");
    resetRuleForm();
    await loadAll();
  } catch (e) { toast(`Failed: ${e.message}`); }
};

$("showSecret").addEventListener("click", () => {
  const input = $("adminSecret");
  input.type = input.type === "password" ? "text" : "password";
  $("showSecret").textContent = input.type === "password" ? "Show" : "Hide";
});

$("unlockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const secret = $("adminSecret").value.trim();
  if (!secret) return;
  state.secret = secret;
  $("unlockError").classList.add("hidden");
  try {
    await loadAll();
    sessionStorage.setItem(SESSION_KEY, secret);
    setUnlocked(true);
  } catch (err) {
    state.secret = "";
    sessionStorage.removeItem(SESSION_KEY);
    $("unlockError").textContent = err.status === 401
      ? "That secret is not correct."
      : `Could not connect: ${err.message}`;
    $("unlockError").classList.remove("hidden");
  }
});

$("logoutBtn").addEventListener("click", () => {
  state.secret = "";
  sessionStorage.removeItem(SESSION_KEY);
  $("adminSecret").value = "";
  setUnlocked(false);
});

$("refreshBtn").addEventListener("click", async () => {
  try { await loadAll(); toast("Dashboard refreshed"); }
  catch (e) { toast(`Refresh failed: ${e.message}`); }
});

$("matchType").addEventListener("change", updateTriggerVisibility);
$("cancelEditBtn").addEventListener("click", resetRuleForm);

$("ruleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("editingRuleId").value;
  const matchType = $("matchType").value;
  const triggerText = $("triggerText").value.trim();
  const replyText = $("replyText").value.trim();
  const priority = Number($("priority").value || 100);
  const enabled = $("ruleEnabled").checked;
  const error = $("ruleFormError");
  error.classList.add("hidden");

  if (!replyText) {
    error.textContent = "Reply text is required.";
    error.classList.remove("hidden");
    return;
  }
  if (!["new_chat", "default"].includes(matchType) && !triggerText) {
    error.textContent = "Enter the message or keyword to match.";
    error.classList.remove("hidden");
    return;
  }

  try {
    await api("rule", {
      method: "POST",
      body: {
        action: id ? "update" : "create",
        id: id ? Number(id) : undefined,
        match_type: matchType,
        trigger_text: triggerText,
        reply_text: replyText,
        priority,
        enabled,
      },
    });
    toast(id ? "Rule updated" : "Rule added");
    resetRuleForm();
    await loadAll();
  } catch (err) {
    error.textContent = `Could not save rule: ${err.message}`;
    error.classList.remove("hidden");
  }
});

$("globalToggle").addEventListener("change", async (e) => {
  const value = e.target.checked;
  try {
    await api("setting", { method: "POST", body: { key: "auto_reply_enabled", value } });
    toast(value ? "Auto replies turned on" : "Auto replies paused");
    await loadAll();
  } catch (err) {
    e.target.checked = !value;
    toast(`Could not update: ${err.message}`);
  }
});

$("registerWebhookBtn").addEventListener("click", async () => {
  try {
    $("registerWebhookBtn").disabled = true;
    $("registerWebhookBtn").textContent = "Registering…";
    await api("register", { method: "POST", body: {} });
    toast("Telegram webhook registered");
    await loadAll();
  } catch (err) {
    toast(`Registration failed: ${err.message}`);
  } finally {
    $("registerWebhookBtn").disabled = false;
    renderStatus();
  }
});

$("resetSeenBtn").addEventListener("click", async () => {
  if (!confirm("Reset all new-messenger memory? Everyone already seen will be treated as new again.")) return;
  try {
    await api("reset_seen", { method: "POST", body: {} });
    toast("New-chat memory reset");
    await loadAll();
  } catch (err) { toast(`Reset failed: ${err.message}`); }
});

(async function init() {
  updateTriggerVisibility();
  if (!state.secret) {
    setUnlocked(false);
    return;
  }
  try {
    await loadAll();
    setUnlocked(true);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    state.secret = "";
    setUnlocked(false);
  }
})();