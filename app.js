const ENDPOINT = "https://iqdttxdowvdxszxbiwua.supabase.co/functions/v1/telegram-auto-reply";
const SESSION_KEY = "arb_public_session";
const $ = (id) => document.getElementById(id);

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  try { tg.ready(); tg.expand(); } catch {}
}

const state = {
  initData: tg && tg.initData ? tg.initData : "",
  session: sessionStorage.getItem(SESSION_KEY) || "",
  bootstrap: null,
  status: null,
  rules: [],
  media: [],
  reviews: [],
  logs: [],
  authMode: "login"
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add("hidden"), 2800);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

async function rawPublic(action, body) {
  const res = await fetch(ENDPOINT + "?public=" + encodeURIComponent(action), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({ ok: false, error: "invalid_response" }));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || ("HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

async function api(action, options = {}) {
  const method = options.method || "GET";
  const res = await fetch(ENDPOINT + "?public=" + encodeURIComponent(action), {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + state.session
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, error: "invalid_response" }));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || ("HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function setAuthenticated(authenticated) {
  $("authView").classList.toggle("hidden", authenticated);
  $("dashboardView").classList.toggle("hidden", !authenticated);
}

function showOutsideTelegram() {
  $("authSubtitle").textContent = "Open the Mini App from Telegram to identify your account securely.";
  $("outsideTelegram").classList.remove("hidden");
  $("pinForm").classList.add("hidden");
}

function showPinForm(bootstrap) {
  $("outsideTelegram").classList.add("hidden");
  $("pinForm").classList.remove("hidden");
  const u = bootstrap.user || {};
  $("telegramUserCard").innerHTML =
    '<div class="user-avatar">' + escapeHtml((u.first_name || "T").slice(0,1).toUpperCase()) + '</div>' +
    '<div><strong>' + escapeHtml(u.first_name || "Telegram User") + '</strong>' +
    (u.username ? '<div class="muted small">@' + escapeHtml(u.username) + '</div>' : '') + '</div>';

  if (bootstrap.needs_pin) {
    state.authMode = "create";
    $("authSubtitle").textContent = "Create a private PIN for your personal auto-reply dashboard.";
    $("pinLabel").textContent = "Create PIN";
    $("confirmPinWrap").classList.remove("hidden");
    $("pinSubmit").textContent = "Create PIN & continue";
  } else {
    state.authMode = "login";
    $("authSubtitle").textContent = "Enter your PIN to open your private dashboard.";
    $("pinLabel").textContent = "Your PIN";
    $("confirmPinWrap").classList.add("hidden");
    $("pinSubmit").textContent = "Unlock my dashboard";
  }

  const t = bootstrap.tenant || {};
  if (t.is_platform_owner) {
    $("trialPreview").textContent = "Platform owner account.";
  } else {
    $("trialPreview").textContent =
      "Your 30-day free trial has " + (t.trial_days_left == null ? "30" : t.trial_days_left) + " day(s) remaining.";
  }
}

async function bootstrapAuth() {
  if (!state.initData) {
    showOutsideTelegram();
    return;
  }
  try {
    const data = await rawPublic("bootstrap", { initData: state.initData });
    state.bootstrap = data;
    showPinForm(data);
    if (state.session) {
      try {
        await loadAll();
        setAuthenticated(true);
      } catch {
        state.session = "";
        sessionStorage.removeItem(SESSION_KEY);
      }
    }
  } catch (e) {
    $("authSubtitle").textContent = "Telegram authentication could not be verified. Close and reopen the Mini App from @Auto_replyerbot.";
    $("outsideTelegram").classList.remove("hidden");
  }
}

$("pinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("pinInput").value.trim();
  const confirmPin = $("confirmPinInput").value.trim();
  const error = $("pinError");
  error.classList.add("hidden");

  if (!/^\d{6,12}$/.test(pin)) {
    error.textContent = "Use a 6–12 digit PIN.";
    error.classList.remove("hidden");
    return;
  }
  if (state.authMode === "create" && pin !== confirmPin) {
    error.textContent = "The two PINs do not match.";
    error.classList.remove("hidden");
    return;
  }

  try {
    const action = state.authMode === "create" ? "set_pin" : "login";
    const data = await rawPublic(action, { initData: state.initData, pin });
    state.session = data.token;
    sessionStorage.setItem(SESSION_KEY, data.token);
    $("pinInput").value = "";
    $("confirmPinInput").value = "";
    await loadAll();
    setAuthenticated(true);
  } catch (err) {
    const map = {
      invalid_pin: "Incorrect PIN.",
      pin_must_be_6_to_12_digits: "Use a 6–12 digit PIN.",
      telegram_auth_required: "Telegram could not verify this session. Reopen the Mini App.",
      pin_already_set: "A PIN already exists. Close and reopen the dashboard, then enter it.",
      pin_locked: "Too many incorrect attempts. PIN login is temporarily locked for 15 minutes."
    };
    error.textContent = map[err.message] || ("Could not continue: " + err.message);
    error.classList.remove("hidden");
  }
});

function labelForRule(rule) {
  const map = {
    exact:"Exact", contains:"Contains", starts_with:"Starts with", ends_with:"Ends with",
    new_chat:"New messenger", default:"Default fallback", photo:"Photo received",
    video:"Video received", pdf:"PDF received", document:"Document received",
    voice:"Voice received", audio:"Audio received", any_media:"Any media", flow_step:"Flow step"
  };
  return map[rule.match_type] || rule.match_type;
}

function triggerDescription(rule) {
  if (rule.match_type === "new_chat") return "First message from a new person";
  if (rule.match_type === "default") return "When no earlier rule matches";
  if (rule.match_type === "flow_step") return "Runs only after another rule";
  if (["photo","video","pdf","document","voice","audio","any_media"].includes(rule.match_type)) return labelForRule(rule);
  return rule.trigger_text || "(empty)";
}

function ruleName(rule) {
  return "#" + rule.id + " · " + labelForRule(rule) + " · " + triggerDescription(rule).slice(0, 60);
}

function renderStatus() {
  const s = state.status;
  if (!s) return;
  const bot = s.bot || {};
  const tenant = s.tenant || {};
  const user = state.bootstrap && state.bootstrap.user ? state.bootstrap.user : {};
  const connected = Boolean(s.business_connected);

  $("botIdentity").textContent =
    (user.first_name ? user.first_name + " · " : "") +
    (bot.username ? "@" + bot.username : "Auto Replyer Bot");

  $("statRules").textContent = s.stats && s.stats.rules != null ? s.stats.rules : 0;
  $("statSeen").textContent = s.stats && s.stats.seen_chats != null ? s.stats.seen_chats : 0;
  $("statReplies").textContent = s.stats && s.stats.replies != null ? s.stats.replies : 0;
  $("statMedia").textContent = s.stats && s.stats.media != null ? s.stats.media : 0;
  $("statReviews").textContent = s.stats && s.stats.pending_reviews != null ? s.stats.pending_reviews : 0;
  $("globalToggle").checked = Boolean(s.auto_reply_enabled);
  $("autoReplyText").textContent = s.auto_reply_enabled ? "ON" : "OFF";

  $("statusDot").className = "dot " + (connected ? "good" : "bad");
  $("connectionTitle").textContent = connected ? "Bot connected to your Telegram profile" : "Connect the bot to your Telegram profile";
  $("connectionDetail").textContent = connected
    ? "Only your rules, media, conversations and review alerts are used for this connection."
    : "Open @Auto_replyerbot, then go to Telegram Settings > Chat Automation and connect it. Premium is not required.";

  $("statusUser").textContent = user.username ? "@" + user.username : (user.first_name || "Telegram user");
  $("statusBot").textContent = bot.username ? "@" + bot.username : "Auto Replyer Bot";
  $("statusBusiness").textContent = connected ? "Connected" : "Not connected";
  $("statusSubscription").textContent = tenant.is_platform_owner ? "Owner" :
    (tenant.subscription_status === "trial" ? "Free trial" : tenant.subscription_status || "—");

  if (tenant.is_platform_owner) {
    $("trialTitle").textContent = "Platform owner";
    $("trialDetail").textContent = "Your account is not limited by the public trial.";
    $("trialBadge").textContent = "OWNER";
  } else {
    const days = tenant.trial_days_left == null ? 0 : tenant.trial_days_left;
    $("trialTitle").textContent = "30-day free trial";
    $("trialDetail").textContent = days + " day(s) remaining · planned Starter price ₦1,000/month · billing is not enforced yet.";
    $("trialBadge").textContent = days + " DAYS LEFT";
  }
}

function populateSelectors() {
  const mediaSelect = $("mediaId");
  const previousMedia = mediaSelect.value;
  const wantedType = $("replyType").value;
  const compatibleMedia = wantedType === "text" ? state.media : state.media.filter((m) => m.media_type === wantedType);
  mediaSelect.innerHTML = '<option value="">Choose saved media…</option>' +
    compatibleMedia.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.display_name) + " — " + escapeHtml(m.media_type) + "</option>").join("");
  if (Array.from(mediaSelect.options).some((o) => o.value === previousMedia)) mediaSelect.value = previousMedia;

  const next = $("nextRuleId");
  const previousNext = next.value;
  const editingId = Number($("editingRuleId").value || 0);
  next.innerHTML = '<option value="">End flow — do nothing automatically</option>' +
    state.rules.filter((r) => Number(r.id) !== editingId)
      .map((r) => '<option value="' + r.id + '">' + escapeHtml(ruleName(r)) + "</option>").join("");
  if (Array.from(next.options).some((o) => o.value === previousNext)) next.value = previousNext;
}

function renderRules() {
  $("ruleCountBadge").textContent = state.rules.length;
  const list = $("rulesList");
  if (!state.rules.length) {
    list.innerHTML = '<div class="empty">No rules yet. Add your first private rule above.</div>';
    return;
  }
  const byId = new Map(state.rules.map((r) => [Number(r.id), r]));
  const mediaById = new Map(state.media.map((m) => [String(m.id), m]));

  list.innerHTML = state.rules.map((r) => {
    const next = r.next_rule_id ? byId.get(Number(r.next_rule_id)) : null;
    const media = r.media_id ? mediaById.get(String(r.media_id)) : null;
    const replySummary = (r.reply_type || "text") === "text"
      ? (r.reply_text || "(no text)")
      : ((r.reply_type || "media") + ": " + (media ? media.display_name : "missing media") + (r.reply_text ? " · " + r.reply_text : ""));
    return '<article class="rule-item ' + (r.enabled ? "" : "rule-off") + '">' +
      '<div class="rule-top"><div>' +
      '<div class="rule-type">' + escapeHtml(labelForRule(r)) + '</div>' +
      '<div class="rule-trigger">' + escapeHtml(triggerDescription(r)) + '</div>' +
      '<div class="rule-reply">' + escapeHtml(replySummary) + '</div>' +
      (next ? '<div class="flow-chip">Next customer message → ' + escapeHtml(ruleName(next)) + '</div>' : '') +
      (r.notify_admin ? '<div class="flow-chip">🔔 Wait for media verification</div>' : '') +
      '<div class="rule-meta"><span>Priority ' + Number(r.priority) + '</span><span>•</span><span>' + (r.enabled ? "Enabled" : "Disabled") + '</span></div>' +
      '</div><div class="rule-actions">' +
      '<button onclick="toggleRule(' + r.id + ',' + (!r.enabled) + ')">' + (r.enabled ? "Disable" : "Enable") + '</button>' +
      '<button onclick="editRule(' + r.id + ')">Edit</button>' +
      '<button class="delete" onclick="deleteRule(' + r.id + ')">Delete</button>' +
      '</div></div></article>';
  }).join("");
}

function renderMedia() {
  $("mediaCountBadge").textContent = state.media.length;
  const list = $("mediaList");
  if (!state.media.length) {
    list.innerHTML = '<div class="empty">No saved media yet. Send media to @Auto_replyerbot, then use /upload Name.</div>';
    return;
  }
  list.innerHTML = state.media.map((m) =>
    '<article class="media-item"><div><strong>' + escapeHtml(m.display_name) + '</strong>' +
    '<div class="muted small">' + escapeHtml(m.media_type) + (m.duration_seconds ? " · " + m.duration_seconds + "s" : "") + '</div></div>' +
    '<span class="badge">' + escapeHtml(m.media_type) + '</span></article>'
  ).join("");
}

function renderReviews() {
  const list = $("reviewsList");
  if (!state.reviews.length) {
    list.innerHTML = '<div class="empty">No reviews yet.</div>';
    return;
  }
  list.innerHTML = state.reviews.map((r) =>
    '<article class="review-item"><div><strong>' + escapeHtml(r.customer_name || "Customer") + '</strong> · ' + escapeHtml(r.media_type) + '</div>' +
    '<div class="review-status ' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</div>' +
    '<div class="log-time">' + escapeHtml(formatTime(r.created_at)) + '</div></article>'
  ).join("");
}

function renderLogs() {
  const list = $("logsList");
  if (!state.logs.length) {
    list.innerHTML = '<div class="empty">No reply history yet.</div>';
    return;
  }
  list.innerHTML = state.logs.map((log) =>
    '<article class="log-item"><div class="log-in">Incoming: ' + escapeHtml(log.incoming_text || "(media/no text)") + '</div>' +
    '<div class="log-out">↳ ' + escapeHtml(log.reply_type || "text") + ': ' + escapeHtml(log.reply_text || "") + '</div>' +
    '<div class="log-time">' + escapeHtml(formatTime(log.created_at)) + '</div></article>'
  ).join("");
}

async function loadAll() {
  const results = await Promise.all([
    api("status"), api("rules"), api("logs"), api("media"), api("reviews")
  ]);
  state.status = results[0];
  state.rules = results[1].rules || [];
  state.logs = results[2].logs || [];
  state.media = results[3].media || [];
  state.reviews = results[4].reviews || [];
  renderStatus();
  populateSelectors();
  renderRules();
  renderMedia();
  renderReviews();
  renderLogs();
}

function updateFormVisibility() {
  const matchType = $("matchType").value;
  $("triggerWrap").classList.toggle("hidden", ["new_chat","default","photo","video","pdf","document","voice","audio","any_media","flow_step"].includes(matchType));
  const replyType = $("replyType").value;
  $("mediaWrap").classList.toggle("hidden", replyType === "text");
  $("replyTextLabel").textContent = replyType === "text" ? "Automatic reply" : "Optional caption / text with media";
  $("replyTextHint").classList.toggle("hidden", replyType === "text");
  $("reviewOptions").classList.toggle("hidden", !$("notifyAdmin").checked);
}

function resetRuleForm() {
  $("editingRuleId").value = "";
  $("ruleFormTitle").textContent = "Add a reply rule";
  $("saveRuleBtn").textContent = "Add rule";
  $("cancelEditBtn").classList.add("hidden");
  $("matchType").value = "exact";
  $("priority").value = "100";
  $("triggerText").value = "";
  $("replyType").value = "text";
  $("mediaId").value = "";
  $("replyText").value = "";
  $("nextRuleId").value = "";
  $("notifyAdmin").checked = false;
  $("approvalReplyText").value = "";
  $("rejectionReplyText").value = "";
  $("ruleEnabled").checked = true;
  $("ruleFormError").classList.add("hidden");
  populateSelectors();
  updateFormVisibility();
}

window.editRule = function(id) {
  const r = state.rules.find((x) => Number(x.id) === Number(id));
  if (!r) return;
  $("editingRuleId").value = r.id;
  $("ruleFormTitle").textContent = "Edit reply rule";
  $("saveRuleBtn").textContent = "Save changes";
  $("cancelEditBtn").classList.remove("hidden");
  $("matchType").value = r.match_type;
  $("priority").value = r.priority;
  $("triggerText").value = r.trigger_text || "";
  $("replyType").value = r.reply_type || "text";
  $("replyText").value = r.reply_text || "";
  $("ruleEnabled").checked = Boolean(r.enabled);
  $("notifyAdmin").checked = Boolean(r.notify_admin);
  $("approvalReplyText").value = r.approval_reply_text || "";
  $("rejectionReplyText").value = r.rejection_reply_text || "";
  populateSelectors();
  $("mediaId").value = r.media_id || "";
  $("nextRuleId").value = r.next_rule_id || "";
  updateFormVisibility();
  window.scrollTo({ top: 0, behavior: "smooth" });
};

window.toggleRule = async function(id, enabled) {
  try {
    await api("rule", { method:"POST", body:{ action:"toggle", id, enabled } });
    toast(enabled ? "Rule enabled" : "Rule disabled");
    await loadAll();
  } catch (e) { toast("Failed: " + e.message); }
};

window.deleteRule = async function(id) {
  if (!confirm("Delete this rule?")) return;
  try {
    await api("rule", { method:"POST", body:{ action:"delete", id } });
    toast("Rule deleted");
    resetRuleForm();
    await loadAll();
  } catch (e) { toast("Failed: " + e.message); }
};

$("refreshBtn").addEventListener("click", async () => {
  try { await loadAll(); toast("Dashboard refreshed"); }
  catch (e) { toast("Refresh failed: " + e.message); }
});

$("logoutBtn").addEventListener("click", () => {
  state.session = "";
  sessionStorage.removeItem(SESSION_KEY);
  setAuthenticated(false);
  showPinForm(state.bootstrap);
});

$("matchType").addEventListener("change", updateFormVisibility);
$("replyType").addEventListener("change", () => { populateSelectors(); updateFormVisibility(); });
$("notifyAdmin").addEventListener("change", updateFormVisibility);
$("cancelEditBtn").addEventListener("click", resetRuleForm);

$("ruleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("editingRuleId").value;
  const matchType = $("matchType").value;
  const triggerText = $("triggerText").value.trim();
  const replyType = $("replyType").value;
  const mediaId = $("mediaId").value || null;
  const replyText = $("replyText").value.trim();
  const error = $("ruleFormError");
  error.classList.add("hidden");

  const noTrigger = ["new_chat","default","photo","video","pdf","document","voice","audio","any_media","flow_step"].includes(matchType);
  if (!noTrigger && !triggerText) {
    error.textContent = "Enter the incoming message or keyword.";
    error.classList.remove("hidden");
    return;
  }
  if (replyType === "text" && !replyText && !$("notifyAdmin").checked) {
    error.textContent = "Enter a text reply, or enable media verification.";
    error.classList.remove("hidden");
    return;
  }
  if (replyType !== "text" && !mediaId) {
    error.textContent = "Choose one of your saved media items.";
    error.classList.remove("hidden");
    return;
  }

  try {
    await api("rule", { method:"POST", body:{
      action:id ? "update" : "create",
      id:id ? Number(id) : undefined,
      match_type:matchType,
      trigger_text:triggerText,
      reply_type:replyType,
      media_id:mediaId,
      reply_text:replyText,
      priority:Number($("priority").value || 100),
      next_rule_id:$("nextRuleId").value ? Number($("nextRuleId").value) : null,
      notify_admin:$("notifyAdmin").checked,
      approval_reply_text:$("approvalReplyText").value.trim(),
      rejection_reply_text:$("rejectionReplyText").value.trim(),
      enabled:$("ruleEnabled").checked
    }});
    toast(id ? "Rule updated" : "Rule added");
    resetRuleForm();
    await loadAll();
  } catch (err) {
    error.textContent = "Could not save rule: " + err.message;
    error.classList.remove("hidden");
  }
});

$("globalToggle").addEventListener("change", async (e) => {
  const value = e.target.checked;
  try {
    await api("setting", { method:"POST", body:{ key:"auto_reply_enabled", value } });
    toast(value ? "Auto replies turned on" : "Auto replies paused");
    await loadAll();
  } catch (err) {
    e.target.checked = !value;
    toast("Could not update: " + err.message);
  }
});

$("resetSeenBtn").addEventListener("click", async () => {
  if (!confirm("Reset your new-messenger memory?")) return;
  try {
    await api("reset_seen", { method:"POST", body:{} });
    toast("New-chat memory reset");
    await loadAll();
  } catch (err) { toast("Reset failed: " + err.message); }
});

(async function init() {
  updateFormVisibility();
  setAuthenticated(false);
  await bootstrapAuth();
})();