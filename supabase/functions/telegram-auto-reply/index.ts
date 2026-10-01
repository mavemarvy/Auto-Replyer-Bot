import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MATCH_TYPES = new Set([
  "new_chat","exact","contains","starts_with","ends_with","default",
  "photo","video","pdf","document","voice","audio","any_media","flow_step"
]);
const REPLY_TYPES = new Set(["text","voice","audio","photo","video","document"]);
const ALLOWED_ORIGINS = new Set([
  "https://auto-replyer-bot.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function cors(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://auto-replyer-bot.vercel.app",
    "Access-Control-Allow-Headers": "content-type, authorization, x-admin-secret, x-telegram-bot-api-secret-token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "content-type": "application/json; charset=utf-8" },
  });
}

async function telegram(method: string, payload: Record<string, unknown>, token: string) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeMessageText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeBotInfo(result: any) {
  if (!result) return null;
  return {
    id: result.id,
    username: result.username ?? null,
    first_name: result.first_name ?? null,
    can_connect_to_business: result.can_connect_to_business ?? false,
    supports_inline_queries: result.supports_inline_queries ?? false,
  };
}

function sanitizeWebhookInfo(result: any) {
  if (!result) return null;
  return {
    url: result.url ?? "",
    pending_update_count: result.pending_update_count ?? 0,
    last_error_date: result.last_error_date ?? null,
    last_error_message: result.last_error_message ?? null,
    allowed_updates: result.allowed_updates ?? [],
  };
}

function getIncomingMedia(message: any) {
  if (message?.voice) return {
    type: "voice", fileId: message.voice.file_id, uniqueId: message.voice.file_unique_id,
    mimeType: message.voice.mime_type ?? "audio/ogg", fileName: null,
    duration: message.voice.duration ?? null, fileSize: message.voice.file_size ?? null,
  };
  if (message?.audio) return {
    type: "audio", fileId: message.audio.file_id, uniqueId: message.audio.file_unique_id,
    mimeType: message.audio.mime_type ?? null, fileName: message.audio.file_name ?? null,
    duration: message.audio.duration ?? null, fileSize: message.audio.file_size ?? null,
  };
  if (message?.photo?.length) {
    const p = message.photo[message.photo.length - 1];
    return {
      type: "photo", fileId: p.file_id, uniqueId: p.file_unique_id,
      mimeType: "image/jpeg", fileName: null, duration: null, fileSize: p.file_size ?? null,
    };
  }
  if (message?.video) return {
    type: "video", fileId: message.video.file_id, uniqueId: message.video.file_unique_id,
    mimeType: message.video.mime_type ?? null, fileName: message.video.file_name ?? null,
    duration: message.video.duration ?? null, fileSize: message.video.file_size ?? null,
  };
  if (message?.document) return {
    type: "document", fileId: message.document.file_id, uniqueId: message.document.file_unique_id,
    mimeType: message.document.mime_type ?? null, fileName: message.document.file_name ?? null,
    duration: null, fileSize: message.document.file_size ?? null,
  };
  return null;
}

function mediaMatches(matchType: string, media: any) {
  if (!media) return false;
  if (matchType === "any_media") return true;
  if (matchType === "pdf") return media.type === "document" && media.mimeType === "application/pdf";
  if (matchType === "document") return media.type === "document";
  return matchType === media.type;
}

async function getSetting(supabase: any, key: string) {
  const { data, error } = await supabase
    .from("telegram_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

async function setSetting(supabase: any, key: string, value: any) {
  const { error } = await supabase
    .from("telegram_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function sendRuleReply(rule: any, connectionId: string, chatId: number, supabase: any, botToken: string) {
  const replyType = rule.reply_type || "text";
  if (replyType === "text") {
    const text = String(rule.reply_text ?? "").trim();
    if (!text) return { sent: false, type: "text", mediaId: null };
    await telegram("sendMessage", {
      business_connection_id: connectionId,
      chat_id: chatId,
      text,
    }, botToken);
    return { sent: true, type: "text", mediaId: null };
  }

  if (!rule.media_id) return { sent: false, type: replyType, mediaId: null };
  const { data: media, error } = await supabase
    .from("telegram_media_library")
    .select("*")
    .eq("id", rule.media_id)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  if (!media) return { sent: false, type: replyType, mediaId: null };

  const methodMap: Record<string,string> = {
    voice: "sendVoice",
    audio: "sendAudio",
    photo: "sendPhoto",
    video: "sendVideo",
    document: "sendDocument",
  };
  const fieldMap: Record<string,string> = {
    voice: "voice",
    audio: "audio",
    photo: "photo",
    video: "video",
    document: "document",
  };
  const method = methodMap[replyType];
  const field = fieldMap[replyType];
  if (!method || !field) return { sent: false, type: replyType, mediaId: media.id };

  const payload: Record<string, unknown> = {
    business_connection_id: connectionId,
    chat_id: chatId,
    [field]: media.telegram_file_id,
  };
  const caption = String(rule.reply_text ?? "").trim();
  if (caption) payload.caption = caption;

  await telegram(method, payload, botToken);
  return { sent: true, type: replyType, mediaId: media.id };
}

async function armNextStep(rule: any, connectionId: string, chatId: number, supabase: any) {
  if (!rule?.next_rule_id) {
    await supabase
      .from("telegram_conversation_states")
      .delete()
      .eq("business_connection_id", connectionId)
      .eq("chat_id", chatId);
    return;
  }
  const ttlRaw = await getSetting(supabase, "flow_state_ttl_hours");
  const ttl = Number(ttlRaw ?? 24);
  const expires = new Date(Date.now() + Math.max(1, ttl) * 3600_000).toISOString();
  const { error } = await supabase
    .from("telegram_conversation_states")
    .upsert({
      business_connection_id: connectionId,
      chat_id: chatId,
      source_rule_id: rule.id,
      next_rule_id: rule.next_rule_id,
      expires_at: expires,
      updated_at: new Date().toISOString(),
    });
  if (error) throw error;
}

async function armMediaReviewExpectation(rule: any, connectionId: string, chatId: number, supabase: any) {
  if (!rule?.notify_admin) return;
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  const { error } = await supabase
    .from("telegram_review_expectations")
    .upsert({
      business_connection_id: connectionId,
      chat_id: chatId,
      source_rule_id: rule.id,
      expires_at: expires,
      created_at: new Date().toISOString(),
    });
  if (error) throw error;
}

async function notifyAdminForReview(
  rule: any,
  message: any,
  media: any,
  connectionId: string,
  supabase: any,
  botToken: string,
) {
  if (!rule?.notify_admin || !media) return;

  const adminChatId = await getSetting(supabase, "notification_chat_id");
  if (!adminChatId) return;

  const customerUserId = message?.from?.id ?? null;
  const customerName = [message?.from?.first_name, message?.from?.last_name].filter(Boolean).join(" ") ||
    message?.from?.username || "Customer";

  const { data: review, error } = await supabase
    .from("telegram_review_queue")
    .insert({
      business_connection_id: connectionId,
      customer_chat_id: message.chat.id,
      customer_user_id: customerUserId,
      customer_name: customerName,
      source_message_id: message.message_id ?? null,
      media_type: media.type,
      telegram_file_id: media.fileId,
      telegram_file_unique_id: media.uniqueId,
      triggered_rule_id: rule.id,
      status: "pending",
    })
    .select()
    .single();
  if (error) throw error;

  const keyboard: any[][] = [[
    { text: "✅ Approve", callback_data: `review:approve:${review.id}` },
    { text: "❌ Reject", callback_data: `review:reject:${review.id}` },
  ]];
  if (customerUserId) {
    keyboard.push([{ text: "💬 Open customer", url: `tg://user?id=${customerUserId}` }]);
  }

  const caption =
    `🔔 Verification required\n\nCustomer: ${customerName}\nType: ${media.type}\nRule: #${rule.id}`;

  const methodMap: Record<string,string> = {
    voice: "sendVoice", audio: "sendAudio", photo: "sendPhoto", video: "sendVideo", document: "sendDocument",
  };
  const fieldMap: Record<string,string> = {
    voice: "voice", audio: "audio", photo: "photo", video: "video", document: "document",
  };
  const method = methodMap[media.type] ?? "sendMessage";
  if (method === "sendMessage") {
    await telegram("sendMessage", {
      chat_id: adminChatId,
      text: caption,
      reply_markup: { inline_keyboard: keyboard },
    }, botToken);
  } else {
    await telegram(method, {
      chat_id: adminChatId,
      [fieldMap[media.type]]: media.fileId,
      caption,
      reply_markup: { inline_keyboard: keyboard },
    }, botToken);
  }
}

async function executeRule(
  rule: any,
  message: any,
  media: any,
  connectionId: string,
  supabase: any,
  botToken: string,
  incomingText: string,
) {
  const result = await sendRuleReply(rule, connectionId, message.chat.id, supabase, botToken);
  await armNextStep(rule, connectionId, message.chat.id, supabase);

  if (rule?.notify_admin) {
    if (media) {
      await notifyAdminForReview(rule, message, media, connectionId, supabase, botToken);
    } else {
      await armMediaReviewExpectation(rule, connectionId, message.chat.id, supabase);
    }
  }

  await supabase.from("telegram_reply_logs").insert({
    business_connection_id: connectionId,
    chat_id: message.chat.id,
    telegram_message_id: message.message_id ?? null,
    incoming_text: incomingText || (media ? `[${media.type}]` : null),
    matched_rule_id: rule.id,
    reply_text: rule.reply_text ?? null,
    reply_type: result.type,
    reply_media_id: result.mediaId,
    status: result.sent || rule.notify_admin ? "sent" : "no_action",
  });
}

async function savePendingMedia(message: any, media: any, supabase: any) {
  const { error } = await supabase.from("telegram_pending_media_uploads").upsert({
    telegram_user_id: message.from.id,
    source_chat_id: message.chat.id,
    source_message_id: message.message_id,
    media_type: media.type,
    telegram_file_id: media.fileId,
    telegram_file_unique_id: media.uniqueId,
    mime_type: media.mimeType,
    file_name: media.fileName,
    duration_seconds: media.duration,
    file_size: media.fileSize,
    received_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function handleDirectBotMessage(message: any, supabase: any, botToken: string) {
  if (!message?.from?.id || message.chat?.type !== "private") return;
  const ownerId = Number(await getSetting(supabase, "owner_telegram_user_id") ?? 0);
  if (!ownerId || Number(message.from.id) !== ownerId) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: ownerId
        ? "This bot's private media uploader is currently restricted to the connected Business account owner."
        : "Owner binding is not ready yet. Send one message to your connected Telegram Business account, then return here and send /start.",
    }, botToken);
    return;
  }

  await setSetting(supabase, "notification_chat_id", message.chat.id);

  const text = String(message.text ?? "").trim();
  const media = getIncomingMedia(message);

  if (text === "/start") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text:
        "✅ Personal Pro v2 is connected.\n\n" +
        "To save media:\n1. Forward or send a voice/photo/video/audio/document here.\n" +
        "2. Then send /upload Name of media\n\nExample: /upload Coach Keshy Introduction\n\nUse /library to list saved media and /cancel to discard a pending upload.",
    }, botToken);
    return;
  }

  if (text === "/resetpin") {
    await supabase.from("telegram_tenants")
      .update({ pin_hash:null, updated_at:new Date().toISOString() })
      .eq("id",tenant.id).eq("telegram_user_id",message.from.id);
    await telegram("sendMessage",{
      chat_id:message.chat.id,
      text:"🔐 Your dashboard PIN has been reset. Open the dashboard again and create a new 6–12 digit PIN.",
      reply_markup:{inline_keyboard:[[{text:"⚙️ Open Dashboard",web_app:{url:DASHBOARD_URL}}]]}
    },botToken);
    return;
  }

  if (text === "/dashboard") {
    await telegram("sendMessage",{
      chat_id:message.chat.id,
      text:"Open your private Auto Replyer dashboard:",
      reply_markup:{inline_keyboard:[[{text:"⚙️ Open My Dashboard",web_app:{url:DASHBOARD_URL}}]]}
    },botToken);
    return;
  }

  if (text === "/help") {
    await telegram("sendMessage",{
      chat_id:message.chat.id,
      text:"Auto Replyer Bot commands:\n\n/start — create/open your account\n/dashboard — open your private dashboard\n/library — list your saved media\n/upload Name — save the last media you sent\n/cancel — discard a pending media upload\n/resetpin — reset your dashboard PIN\n\nTo let the bot answer your personal chats, go to Telegram Settings > Chat Automation and connect @Auto_replyerbot."
    },botToken);
    return;
  }

  if (text === "/library") {
    const { data, error } = await supabase
      .from("telegram_media_library")
      .select("display_name,media_type,created_at")
      .eq("enabled", true)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    const body = (data ?? []).length
      ? (data ?? []).map((m: any, i: number) => `${i + 1}. ${m.display_name} — ${m.media_type}`).join("\n")
      : "No saved media yet.";
    await telegram("sendMessage", { chat_id: message.chat.id, text: `📚 Media Library\n\n${body}` }, botToken);
    return;
  }

  if (text === "/cancel") {
    await supabase.from("telegram_pending_media_uploads").delete().eq("telegram_user_id", message.from.id);
    await telegram("sendMessage", { chat_id: message.chat.id, text: "Pending media upload cleared." }, botToken);
    return;
  }

  if (text.toLowerCase().startsWith("/upload")) {
    const access = await getTenantAccess(supabase,tenant);
    if (!access.allowed || access.level !== "pro") {
      await telegram("sendMessage",{chat_id:message.chat.id,
        text:"🔒 Media replies are a Pro feature. Your 30-day trial includes Pro; after it ends, activate Pro or a referral bonus hour to save/use media."
      },botToken);
      return;
    }
    if (!tenant.is_platform_owner) {
      const countQ = await supabase.from("telegram_media_library")
        .select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id).eq("enabled",true);
      if (countQ.error) throw countQ.error;
      const plan = await getPlanRecord(supabase,"pro");
      const maxMedia = Number(plan?.max_media_items ?? 5);
      if ((countQ.count ?? 0) >= maxMedia) {
        await telegram("sendMessage",{chat_id:message.chat.id,
          text:"You have reached the Pro media limit of "+maxMedia+" saved items. Delete/disable an old media item before adding another."
        },botToken);
        return;
      }
    }
    const name = text.slice(7).trim();
    if (!name) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "Use /upload followed by a name. Example: /upload Welcome Voice" }, botToken);
      return;
    }
    const { data: pending, error } = await supabase
      .from("telegram_pending_media_uploads")
      .select("*")
      .eq("telegram_user_id", message.from.id)
      .maybeSingle();
    if (error) throw error;
    if (!pending) {
      await telegram("sendMessage", { chat_id: message.chat.id, text: "No pending media found. Send or forward the media first, then use /upload Name." }, botToken);
      return;
    }
    const { data: saved, error: saveError } = await supabase
      .from("telegram_media_library")
      .insert({
        display_name: name,
        media_type: pending.media_type,
        telegram_file_id: pending.telegram_file_id,
        telegram_file_unique_id: pending.telegram_file_unique_id,
        mime_type: pending.mime_type,
        file_name: pending.file_name,
        duration_seconds: pending.duration_seconds,
        file_size: pending.file_size,
        created_by_telegram_user_id: message.from.id,
      })
      .select()
      .single();
    if (saveError) throw saveError;
    await supabase.from("telegram_pending_media_uploads").delete().eq("telegram_user_id", message.from.id);
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `✅ Saved to Media Library\n\nName: ${saved.display_name}\nType: ${saved.media_type}\n\nIt is now available as an auto-reply action in the dashboard.`,
    }, botToken);
    return;
  }

  if (media) {
    await savePendingMedia(message, media, supabase);
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: `📥 ${media.type} received.\n\nNow send:\n/upload Your Media Name\n\nExample: /upload Coach Keshy Introduction`,
    }, botToken);
  }
}

async function handleReviewCallback(query: any, supabase: any, botToken: string) {
  const data = String(query?.data ?? "");
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "review") return;
  const action = parts[1];
  const reviewId = parts[2];

  const ownerId = Number(await getSetting(supabase, "owner_telegram_user_id") ?? 0);
  if (!ownerId || Number(query?.from?.id) !== ownerId) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Not authorized.", show_alert: true }, botToken);
    return;
  }

  const { data: review, error } = await supabase
    .from("telegram_review_queue")
    .select("*, telegram_auto_reply_rules(approval_reply_text,rejection_reply_text)")
    .eq("id", reviewId)
    .maybeSingle();
  if (error) throw error;
  if (!review || review.status !== "pending") {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "This review has already been handled." }, botToken);
    return;
  }

  const approved = action === "approve";
  const rejected = action === "reject";
  if (!approved && !rejected) return;

  await supabase
    .from("telegram_review_queue")
    .update({ status: approved ? "approved" : "rejected", reviewed_at: new Date().toISOString() })
    .eq("id", reviewId);

  const rule = review.telegram_auto_reply_rules;
  const customerText = approved
    ? String(rule?.approval_reply_text ?? "").trim()
    : String(rule?.rejection_reply_text ?? "").trim();

  if (customerText) {
    await telegram("sendMessage", {
      business_connection_id: review.business_connection_id,
      chat_id: review.customer_chat_id,
      text: customerText,
    }, botToken);
  }

  await telegram("answerCallbackQuery", {
    callback_query_id: query.id,
    text: approved ? "Approved." : "Rejected.",
  }, botToken);

  if (query?.message?.chat?.id && query?.message?.message_id) {
    await telegram("editMessageReplyMarkup", {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }, botToken);
    await telegram("sendMessage", {
      chat_id: query.message.chat.id,
      text: approved ? "✅ Verification approved." : "❌ Verification rejected.",
    }, botToken);
  }
}


const DASHBOARD_URL = "https://auto-replyer-bot.vercel.app";
const BOT_USERNAME = "Auto_replyerbot";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64urlEncodeText(value: string) {
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecodeText(value: string) {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const bin = atob(normalized);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmacSha256(key: string | Uint8Array, data: string) {
  const raw = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function safeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function validateTelegramInitData(initData: string, botToken: string) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash") || "";
  const authDate = Number(params.get("auth_date") || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!receivedHash || !authDate || Math.abs(now - authDate) > 86400) return null;

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key !== "hash") pairs.push(key + "=" + value);
  }
  pairs.sort();
  const dataCheck = pairs.join("\n");
  const secretKey = await hmacSha256("WebAppData", botToken);
  const expected = bytesToHex(await hmacSha256(secretKey, dataCheck));
  if (!safeEqualHex(expected, receivedHash)) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}");
    if (!user?.id) return null;
    return user;
  } catch {
    return null;
  }
}

async function hashPin(pin: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return "pbkdf2$120000$" + bytesToHex(salt) + "$" + bytesToHex(new Uint8Array(bits));
}

async function verifyPin(pin: string, stored: string | null) {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2]);
  const expected = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial, 256
  );
  return safeEqualHex(bytesToHex(new Uint8Array(bits)), expected);
}

async function makeSession(tenantId: string, userId: number, secret: string) {
  const payload = {
    tid: tenantId,
    uid: userId,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  };
  const encoded = b64urlEncodeText(JSON.stringify(payload));
  const signature = bytesToHex(await hmacSha256(secret, encoded));
  return encoded + "." + signature;
}

async function readSession(req: Request, secret: string) {
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = bytesToHex(await hmacSha256(secret, parts[0]));
  if (!safeEqualHex(expected, parts[1])) return null;
  try {
    const payload = JSON.parse(b64urlDecodeText(parts[0]));
    if (!payload?.tid || !payload?.uid || Number(payload.exp) < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function ensureTenant(supabase: any, user: any) {
  const uid = Number(user.id);
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Telegram User";
  const username = user.username || null;

  let { data: tenant, error } = await supabase
    .from("telegram_tenants")
    .select("*")
    .eq("telegram_user_id", uid)
    .maybeSingle();
  if (error) throw error;

  if (!tenant) {
    const inserted = await supabase
      .from("telegram_tenants")
      .insert({
        telegram_user_id: uid,
        display_name: name,
        username,
        subscription_status: "trial",
        plan_code: "basic",
      })
      .select()
      .single();
    if (inserted.error) throw inserted.error;
    tenant = inserted.data;

    await supabase.from("telegram_subscriptions").insert({
      tenant_id: tenant.id,
      plan_code: "basic",
      status: "trial",
      trial_end: tenant.trial_ends_at,
    });

    await supabase.from("telegram_tenant_settings").insert([
      { tenant_id: tenant.id, key: "auto_reply_enabled", value: true },
      { tenant_id: tenant.id, key: "flow_state_ttl_hours", value: 24 },
    ]);
  } else {
    await supabase
      .from("telegram_tenants")
      .update({ display_name: name, username, updated_at: new Date().toISOString() })
      .eq("id", tenant.id);
  }
  return tenant;
}

async function getTenantSetting(supabase: any, tenantId: string, key: string, fallback: any = null) {
  const { data, error } = await supabase
    .from("telegram_tenant_settings")
    .select("value")
    .eq("tenant_id", tenantId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? fallback;
}

async function setTenantSetting(supabase: any, tenantId: string, key: string, value: any) {
  const { error } = await supabase
    .from("telegram_tenant_settings")
    .upsert({ tenant_id: tenantId, key, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function tenantForConnection(supabase: any, connectionId: string, botToken: string) {
  let { data: connection, error } = await supabase
    .from("telegram_business_connections")
    .select("*, telegram_tenants(*)")
    .eq("business_connection_id", connectionId)
    .maybeSingle();
  if (error) throw error;
  if (connection?.telegram_tenants) return { tenant: connection.telegram_tenants, connection };

  const remote = await telegram("getBusinessConnection", {
    business_connection_id: connectionId,
  }, botToken);
  const bc = remote?.result;
  if (!bc?.user?.id) return null;

  const tenant = await ensureTenant(supabase, bc.user);
  const upserted = await supabase
    .from("telegram_business_connections")
    .upsert({
      business_connection_id: connectionId,
      tenant_id: tenant.id,
      telegram_user_id: Number(bc.user.id),
      is_enabled: bc.is_enabled !== false,
      rights: bc.rights || null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (upserted.error) throw upserted.error;
  return { tenant, connection: upserted.data };
}

async function getTenantAccess(supabase: any, tenant: any) {
  if (tenant?.is_platform_owner) {
    return { allowed:true, level:"pro", source:"owner", expires_at:null, features:"all" };
  }

  const enforcement = await getSetting(supabase, "billing_enforcement_enabled");
  if (enforcement !== true) {
    return { allowed:true, level:"pro", source:"billing_disabled", expires_at:null, features:"all" };
  }

  const now = Date.now();
  if (tenant?.subscription_status === "trial" && new Date(tenant.trial_ends_at).getTime() > now) {
    return { allowed:true, level:"pro", source:"trial", expires_at:tenant.trial_ends_at, features:"all" };
  }

  const subscriptionQ = await supabase.from("telegram_subscriptions")
    .select("*").eq("tenant_id",tenant.id).maybeSingle();
  if (subscriptionQ.error) throw subscriptionQ.error;
  const sub = subscriptionQ.data;

  if (tenant?.subscription_status === "active" && sub?.status === "active") {
    const stillCurrent = !sub.current_period_end || new Date(sub.current_period_end).getTime() > now;
    if (stillCurrent) {
      const code = tenant.plan_code === "pro" ? "pro" : "basic";
      return { allowed:true, level:code, source:"subscription", expires_at:sub.current_period_end ?? null, features:code };
    }
  }

  if (tenant?.referral_bonus_until && new Date(tenant.referral_bonus_until).getTime() > now) {
    return { allowed:true, level:"pro", source:"referral_bonus", expires_at:tenant.referral_bonus_until, features:"all" };
  }

  return { allowed:false, level:"locked", source:"expired", expires_at:null, features:"none" };
}

function ruleAllowedForAccess(rule:any, access:any) {
  if (!access?.allowed) return false;
  if (access.level === "pro") return true;
  if (access.level !== "basic") return false;

  const basicTriggers = new Set(["new_chat","exact","contains","starts_with","ends_with","default"]);
  if (!basicTriggers.has(String(rule.match_type))) return false;
  if (String(rule.reply_type || "text") !== "text") return false;
  if (rule.notify_admin) return false;
  if (rule.next_rule_id) return false;
  if (rule.media_id) return false;
  return true;
}

async function getPlanRecord(supabase:any, code:string) {
  const q = await supabase.from("telegram_plans").select("*").eq("code",code).maybeSingle();
  if (q.error) throw q.error;
  return q.data;
}

async function getReferralSummary(supabase:any, tenant:any) {
  const [allQ, qualQ] = await Promise.all([
    supabase.from("telegram_referrals").select("*",{count:"exact",head:true}).eq("referrer_tenant_id",tenant.id),
    supabase.from("telegram_referrals").select("*",{count:"exact",head:true}).eq("referrer_tenant_id",tenant.id).eq("status","qualified")
  ]);
  if (allQ.error) throw allQ.error;
  if (qualQ.error) throw qualQ.error;
  return {
    code: tenant.referral_code,
    link: "https://t.me/Auto_replyerbot?start=ref_" + tenant.referral_code,
    total_referrals: allQ.count ?? 0,
    qualified_referrals: qualQ.count ?? 0,
    bonus_seconds_balance: Number(tenant.referral_bonus_seconds ?? 0),
    bonus_until: tenant.referral_bonus_until ?? null,
  };
}

async function awardReferralBonuses(supabase:any, referrerTenantId:string) {
  const perHour = Number(await getSetting(supabase,"referrals_per_bonus_hour") ?? 2);
  const secondsPerReward = Number(await getSetting(supabase,"referral_bonus_seconds_per_reward") ?? 3600);
  if (perHour < 1 || secondsPerReward < 1) return;

  while (true) {
    const q = await supabase.from("telegram_referrals")
      .select("id").eq("referrer_tenant_id",referrerTenantId)
      .eq("status","qualified").eq("bonus_awarded",false)
      .order("qualified_at",{ascending:true}).limit(perHour);
    if (q.error) throw q.error;
    const rows = q.data ?? [];
    if (rows.length < perHour) break;

    const ids = rows.map((r:any)=>r.id);
    const upd = await supabase.from("telegram_referrals")
      .update({bonus_awarded:true}).in("id",ids).eq("referrer_tenant_id",referrerTenantId);
    if (upd.error) throw upd.error;

    const tenantQ = await supabase.from("telegram_tenants")
      .select("referral_bonus_seconds").eq("id",referrerTenantId).maybeSingle();
    if (tenantQ.error) throw tenantQ.error;
    const nextSeconds = Number(tenantQ.data?.referral_bonus_seconds ?? 0) + secondsPerReward;

    const tUpd = await supabase.from("telegram_tenants")
      .update({referral_bonus_seconds:nextSeconds,updated_at:new Date().toISOString()})
      .eq("id",referrerTenantId);
    if (tUpd.error) throw tUpd.error;

    await supabase.from("telegram_referral_bonus_events").insert({
      tenant_id:referrerTenantId,seconds_added:secondsPerReward,
      reason:"qualified_referrals",source_referral_ids:ids
    });
  }
}

async function linkReferralFromStart(supabase:any, tenant:any, startText:string) {
  const match = String(startText||"").match(/^\/start\s+ref_([A-Za-z0-9]+)$/i);
  if (!match || tenant.is_platform_owner) return;
  const code = match[1].toUpperCase();

  const referrerQ = await supabase.from("telegram_tenants")
    .select("id,referral_code").eq("referral_code",code).maybeSingle();
  if (referrerQ.error) throw referrerQ.error;
  if (!referrerQ.data || referrerQ.data.id === tenant.id) return;

  const existing = await supabase.from("telegram_referrals")
    .select("id").eq("referred_tenant_id",tenant.id).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return;

  await supabase.from("telegram_referrals").insert({
    referrer_tenant_id:referrerQ.data.id,
    referred_tenant_id:tenant.id,
    referral_code:code,
    status:"pending"
  });
}

async function tryQualifyReferral(supabase:any, tenant:any) {
  if (!tenant || tenant.is_platform_owner || !tenant.pin_hash) return;
  const connQ = await supabase.from("telegram_business_connections")
    .select("business_connection_id").eq("tenant_id",tenant.id).eq("is_enabled",true).limit(1);
  if (connQ.error) throw connQ.error;
  if (!(connQ.data??[]).length) return;

  const refQ = await supabase.from("telegram_referrals")
    .select("*").eq("referred_tenant_id",tenant.id).eq("status","pending").maybeSingle();
  if (refQ.error) throw refQ.error;
  if (!refQ.data) return;

  const upd = await supabase.from("telegram_referrals")
    .update({status:"qualified",qualified_at:new Date().toISOString()})
    .eq("id",refQ.data.id).eq("status","pending");
  if (upd.error) throw upd.error;
  await awardReferralBonuses(supabase,refQ.data.referrer_tenant_id);
}

async function tenantAccessAllowed(supabase:any, tenant:any) {
  return (await getTenantAccess(supabase,tenant)).allowed;
}

async function v3SendRuleReply(rule: any, tenantId: string, connectionId: string, chatId: number, supabase: any, botToken: string) {
  const replyType = rule.reply_type || "text";
  if (replyType === "text") {
    const text = String(rule.reply_text ?? "").trim();
    if (!text) return { sent: false, type: "text", mediaId: null };
    await telegram("sendMessage", { business_connection_id: connectionId, chat_id: chatId, text }, botToken);
    return { sent: true, type: "text", mediaId: null };
  }

  if (!rule.media_id) return { sent: false, type: replyType, mediaId: null };
  const { data: media, error } = await supabase
    .from("telegram_media_library")
    .select("*")
    .eq("id", rule.media_id)
    .eq("tenant_id", tenantId)
    .eq("enabled", true)
    .maybeSingle();
  if (error) throw error;
  if (!media) return { sent: false, type: replyType, mediaId: null };

  const methodMap: any = { voice:"sendVoice", audio:"sendAudio", photo:"sendPhoto", video:"sendVideo", document:"sendDocument" };
  const fieldMap: any = { voice:"voice", audio:"audio", photo:"photo", video:"video", document:"document" };
  const method = methodMap[replyType];
  const field = fieldMap[replyType];
  if (!method || !field) return { sent:false, type:replyType, mediaId:media.id };

  const payload: any = { business_connection_id:connectionId, chat_id:chatId };
  payload[field] = media.telegram_file_id;
  const caption = String(rule.reply_text ?? "").trim();
  if (caption) payload.caption = caption;
  await telegram(method, payload, botToken);
  return { sent:true, type:replyType, mediaId:media.id };
}

async function v3ArmNext(rule: any, tenantId: string, connectionId: string, chatId: number, supabase: any) {
  if (!rule?.next_rule_id) {
    await supabase.from("telegram_conversation_states")
      .delete().eq("tenant_id",tenantId).eq("business_connection_id",connectionId).eq("chat_id",chatId);
    return;
  }
  const ttl = Number(await getTenantSetting(supabase, tenantId, "flow_state_ttl_hours", 24));
  const expires = new Date(Date.now() + Math.max(1, ttl) * 3600000).toISOString();
  const { error } = await supabase.from("telegram_conversation_states").upsert({
    tenant_id: tenantId, business_connection_id: connectionId, chat_id: chatId,
    source_rule_id: rule.id, next_rule_id: rule.next_rule_id,
    expires_at: expires, updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function v3ArmReview(rule: any, tenantId: string, connectionId: string, chatId: number, supabase: any) {
  if (!rule?.notify_admin) return;
  const { error } = await supabase.from("telegram_review_expectations").upsert({
    tenant_id: tenantId, business_connection_id:connectionId, chat_id:chatId,
    source_rule_id:rule.id, expires_at:new Date(Date.now()+24*3600000).toISOString(),
    created_at:new Date().toISOString(),
  });
  if (error) throw error;
}

async function v3NotifyReview(rule: any, tenant: any, message: any, media: any, connectionId: string, supabase: any, botToken: string) {
  if (!rule?.notify_admin || !media) return;
  const adminChatId = await getTenantSetting(supabase, tenant.id, "notification_chat_id", null);
  if (!adminChatId) return;

  const customerUserId = message?.from?.id ?? null;
  const customerName = [message?.from?.first_name,message?.from?.last_name].filter(Boolean).join(" ") ||
    message?.from?.username || "Customer";

  const inserted = await supabase.from("telegram_review_queue").insert({
    tenant_id:tenant.id, business_connection_id:connectionId, customer_chat_id:message.chat.id,
    customer_user_id:customerUserId, customer_name:customerName, source_message_id:message.message_id ?? null,
    media_type:media.type, telegram_file_id:media.fileId, telegram_file_unique_id:media.uniqueId,
    triggered_rule_id:rule.id, status:"pending",
  }).select().single();
  if (inserted.error) throw inserted.error;
  const review = inserted.data;

  const keyboard: any[][] = [[
    { text:"✅ Approve", callback_data:"review:approve:"+review.id },
    { text:"❌ Reject", callback_data:"review:reject:"+review.id },
  ]];
  if (customerUserId) keyboard.push([{ text:"💬 Open customer", url:"tg://user?id="+customerUserId }]);

  const caption = "🔔 Verification required\n\nCustomer: " + customerName +
    "\nType: " + media.type + "\nRule: #" + rule.id;
  const methodMap:any = { voice:"sendVoice", audio:"sendAudio", photo:"sendPhoto", video:"sendVideo", document:"sendDocument" };
  const fieldMap:any = { voice:"voice", audio:"audio", photo:"photo", video:"video", document:"document" };
  const method = methodMap[media.type] || "sendMessage";

  if (method === "sendMessage") {
    await telegram("sendMessage",{chat_id:adminChatId,text:caption,reply_markup:{inline_keyboard:keyboard}},botToken);
  } else {
    const payload:any = {chat_id:adminChatId,caption,reply_markup:{inline_keyboard:keyboard}};
    payload[fieldMap[media.type]] = media.fileId;
    await telegram(method,payload,botToken);
  }
}

async function v3ExecuteRule(rule:any, tenant:any, message:any, media:any, connectionId:string, supabase:any, botToken:string, incomingText:string) {
  const result = await v3SendRuleReply(rule,tenant.id,connectionId,message.chat.id,supabase,botToken);
  await v3ArmNext(rule,tenant.id,connectionId,message.chat.id,supabase);
  if (rule?.notify_admin) {
    if (media) await v3NotifyReview(rule,tenant,message,media,connectionId,supabase,botToken);
    else await v3ArmReview(rule,tenant.id,connectionId,message.chat.id,supabase);
  }
  await supabase.from("telegram_reply_logs").insert({
    tenant_id:tenant.id, business_connection_id:connectionId, chat_id:message.chat.id,
    telegram_message_id:message.message_id ?? null,
    incoming_text:incomingText || (media ? "["+media.type+"]" : null),
    matched_rule_id:rule.id, reply_text:rule.reply_text ?? null,
    reply_type:result.type, reply_media_id:result.mediaId,
    status:(result.sent || rule.notify_admin) ? "sent" : "no_action",
  });
}

async function v3HandleDirectBotMessage(message:any, supabase:any, botToken:string) {
  if (!message?.from?.id || message.chat?.type !== "private") return;
  const tenant = await ensureTenant(supabase,message.from);
  await setTenantSetting(supabase,tenant.id,"notification_chat_id",message.chat.id);
  const text = String(message.text ?? "").trim();
  const media = getIncomingMedia(message);

  if (text === "/start" || text.startsWith("/start ")) {
    await linkReferralFromStart(supabase,tenant,text);
    await telegram("sendMessage",{
      chat_id:message.chat.id,
      text:"👋 Welcome to Auto Replyer Bot.\n\nYour account starts with a 30-day full-access trial. After the trial: Basic is ₦1,000/month and Pro is ₦2,000/month.\n\nConnect this bot from Telegram Settings > Chat Automation, then open your private dashboard to create a PIN and rules. Premium is not required.\n\nReferral bonus: every 2 qualified referrals earns 1 hour of full Pro access when your paid/trial access is inactive.",
      reply_markup:{inline_keyboard:[
        [{text:"⚙️ Open My Dashboard",web_app:{url:DASHBOARD_URL}}],
        [{text:"📖 Media Library",callback_data:"open_library"}]
      ]}
    },botToken);
    return;
  }

  if (text === "/library") {
    const {data,error} = await supabase.from("telegram_media_library")
      .select("display_name,media_type,created_at")
      .eq("tenant_id",tenant.id).eq("enabled",true)
      .order("created_at",{ascending:false}).limit(30);
    if (error) throw error;
    const body = (data??[]).length
      ? (data??[]).map((m:any,i:number)=>(i+1)+". "+m.display_name+" — "+m.media_type).join("\n")
      : "No saved media yet.";
    await telegram("sendMessage",{chat_id:message.chat.id,text:"📚 Your Media Library\n\n"+body},botToken);
    return;
  }

  if (text === "/cancel") {
    await supabase.from("telegram_pending_media_uploads")
      .delete().eq("tenant_id",tenant.id).eq("telegram_user_id",message.from.id);
    await telegram("sendMessage",{chat_id:message.chat.id,text:"Pending media upload cleared."},botToken);
    return;
  }

  if (text.toLowerCase().startsWith("/upload")) {
    const access = await getTenantAccess(supabase,tenant);
    if (!access.allowed || access.level !== "pro") {
      await telegram("sendMessage",{chat_id:message.chat.id,
        text:"🔒 Media replies are available on Pro. Your 30-day trial and referral bonus hours include Pro access."
      },botToken);
      return;
    }
    if (!tenant.is_platform_owner) {
      const countQ = await supabase.from("telegram_media_library")
        .select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id).eq("enabled",true);
      if (countQ.error) throw countQ.error;
      const proPlan = await getPlanRecord(supabase,"pro");
      const maxMedia = Number(proPlan?.max_media_items ?? 5);
      if ((countQ.count ?? 0) >= maxMedia) {
        await telegram("sendMessage",{chat_id:message.chat.id,
          text:"You have reached your Pro limit of "+maxMedia+" saved media items."
        },botToken);
        return;
      }
    }
    const name = text.slice(7).trim();
    if (!name) {
      await telegram("sendMessage",{chat_id:message.chat.id,text:"Use /upload followed by a name. Example: /upload Welcome Voice"},botToken);
      return;
    }
    const pending = await supabase.from("telegram_pending_media_uploads")
      .select("*").eq("tenant_id",tenant.id).eq("telegram_user_id",message.from.id).maybeSingle();
    if (pending.error) throw pending.error;
    if (!pending.data) {
      await telegram("sendMessage",{chat_id:message.chat.id,text:"No pending media found. Send or forward the media first, then use /upload Name."},botToken);
      return;
    }
    const saved = await supabase.from("telegram_media_library").insert({
      tenant_id:tenant.id, display_name:name, media_type:pending.data.media_type,
      telegram_file_id:pending.data.telegram_file_id, telegram_file_unique_id:pending.data.telegram_file_unique_id,
      mime_type:pending.data.mime_type, file_name:pending.data.file_name,
      duration_seconds:pending.data.duration_seconds, file_size:pending.data.file_size,
      created_by_telegram_user_id:message.from.id,
    }).select().single();
    if (saved.error) throw saved.error;
    await supabase.from("telegram_pending_media_uploads")
      .delete().eq("tenant_id",tenant.id).eq("telegram_user_id",message.from.id);
    await telegram("sendMessage",{chat_id:message.chat.id,
      text:"✅ Saved to your Media Library\n\nName: "+saved.data.display_name+"\nType: "+saved.data.media_type
    },botToken);
    return;
  }

  if (media) {
    const {error} = await supabase.from("telegram_pending_media_uploads").upsert({
      tenant_id:tenant.id, telegram_user_id:message.from.id, source_chat_id:message.chat.id,
      source_message_id:message.message_id, media_type:media.type, telegram_file_id:media.fileId,
      telegram_file_unique_id:media.uniqueId, mime_type:media.mimeType, file_name:media.fileName,
      duration_seconds:media.duration, file_size:media.fileSize, received_at:new Date().toISOString(),
    });
    if (error) throw error;
    await telegram("sendMessage",{chat_id:message.chat.id,
      text:"📥 "+media.type+" received.\n\nNow send:\n/upload Your Media Name"
    },botToken);
  }
}

async function v3HandleReviewCallback(query:any, supabase:any, botToken:string) {
  const parts = String(query?.data ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== "review") return false;
  const reviewId = parts[2];
  const action = parts[1];

  const reviewQ = await supabase.from("telegram_review_queue")
    .select("*, telegram_auto_reply_rules(approval_reply_text,rejection_reply_text), telegram_tenants(telegram_user_id)")
    .eq("id",reviewId).maybeSingle();
  if (reviewQ.error) throw reviewQ.error;
  const review = reviewQ.data;
  if (!review || review.status !== "pending") {
    await telegram("answerCallbackQuery",{callback_query_id:query.id,text:"This review has already been handled."},botToken);
    return true;
  }
  if (Number(review.telegram_tenants?.telegram_user_id) !== Number(query?.from?.id)) {
    await telegram("answerCallbackQuery",{callback_query_id:query.id,text:"Not authorized.",show_alert:true},botToken);
    return true;
  }

  const approved = action === "approve";
  const rejected = action === "reject";
  if (!approved && !rejected) return true;

  await supabase.from("telegram_review_queue").update({
    status:approved?"approved":"rejected", reviewed_at:new Date().toISOString()
  }).eq("id",reviewId).eq("tenant_id",review.tenant_id);

  const customerText = approved
    ? String(review.telegram_auto_reply_rules?.approval_reply_text ?? "").trim()
    : String(review.telegram_auto_reply_rules?.rejection_reply_text ?? "").trim();

  if (customerText) {
    await telegram("sendMessage",{
      business_connection_id:review.business_connection_id,
      chat_id:review.customer_chat_id,text:customerText
    },botToken);
  }
  await telegram("answerCallbackQuery",{callback_query_id:query.id,text:approved?"Approved.":"Rejected."},botToken);
  if (query?.message?.chat?.id && query?.message?.message_id) {
    await telegram("editMessageReplyMarkup",{
      chat_id:query.message.chat.id,message_id:query.message.message_id,
      reply_markup:{inline_keyboard:[]}
    },botToken);
    await telegram("sendMessage",{chat_id:query.message.chat.id,
      text:approved?"✅ Verification approved.":"❌ Verification rejected."
    },botToken);
  }
  return true;
}

async function publicApi(req:Request, action:string, supabase:any, botToken:string, masterSecret:string) {
  if (action === "bootstrap" || action === "set_pin" || action === "login") {
    if (req.method !== "POST") return json(req,{ok:false,error:"method_not_allowed"},405);
    const body = await req.json();
    const user = await validateTelegramInitData(String(body?.initData ?? ""),botToken);
    if (!user) return json(req,{ok:false,error:"telegram_auth_required"},401);
    const tenant = await ensureTenant(supabase,user);

    const connections = await supabase.from("telegram_business_connections")
      .select("business_connection_id,is_enabled,connected_at")
      .eq("tenant_id",tenant.id).eq("is_enabled",true);
    if (connections.error) throw connections.error;

    if (action === "bootstrap") {
      const [basicPlanQ,proPlanQ] = await Promise.all([
        supabase.from("telegram_plans").select("*").eq("code","basic").maybeSingle(),
        supabase.from("telegram_plans").select("*").eq("code","pro").maybeSingle()
      ]);
      if (basicPlanQ.error) throw basicPlanQ.error;
      if (proPlanQ.error) throw proPlanQ.error;
      const daysLeft = Math.max(0,Math.ceil((new Date(tenant.trial_ends_at).getTime()-Date.now())/86400000));
      const access = await getTenantAccess(supabase,tenant);
      const referral = await getReferralSummary(supabase,tenant);
      return json(req,{ok:true,needs_pin:!tenant.pin_hash,user:{
        id:user.id,first_name:user.first_name||"",username:user.username||null
      },tenant:{
        id:tenant.id,display_name:tenant.display_name,subscription_status:tenant.subscription_status,
        trial_ends_at:tenant.trial_ends_at,trial_days_left:daysLeft,is_platform_owner:tenant.is_platform_owner,
        business_connected:(connections.data??[]).length>0,
        plan_code:tenant.plan_code,access
      },
      plans:[basicPlanQ.data,proPlanQ.data].filter(Boolean).map((p:any)=>({
        code:p.code,name:p.name,currency:p.currency,monthly_price_minor:p.monthly_price_minor,
        usd_price_cents:p.usd_price_cents,stars_price:p.stars_price,trial_days:p.trial_days,
        max_media_items:p.max_media_items,features:p.features
      })),
      referral});
    }

    const pin = String(body?.pin ?? "");
    if (!/^\d{6,12}$/.test(pin)) return json(req,{ok:false,error:"pin_must_be_6_to_12_digits"},400);

    if (action === "set_pin") {
      if (tenant.pin_hash) return json(req,{ok:false,error:"pin_already_set"},409);
      const hashed = await hashPin(pin);
      await supabase.from("telegram_tenants").update({pin_hash:hashed,updated_at:new Date().toISOString()}).eq("id",tenant.id);
      tenant.pin_hash = hashed;
      await tryQualifyReferral(supabase,tenant);
      const token = await makeSession(tenant.id,Number(user.id),masterSecret);
      return json(req,{ok:true,token});
    }

    const securityQ = await supabase.from("telegram_auth_security")
      .select("*").eq("tenant_id",tenant.id).maybeSingle();
    if (securityQ.error) throw securityQ.error;
    const security = securityQ.data;
    if (security?.locked_until && new Date(security.locked_until).getTime() > Date.now()) {
      const retry = Math.max(1,Math.ceil((new Date(security.locked_until).getTime()-Date.now())/1000));
      return json(req,{ok:false,error:"pin_locked",retry_after_seconds:retry},429);
    }

    const validPin = await verifyPin(pin,tenant.pin_hash);
    if (!validPin) {
      const baseAttempts = security?.locked_until ? 0 : Number(security?.failed_attempts ?? 0);
      const failed = baseAttempts + 1;
      const shouldLock = failed >= 5;
      const lockedUntil = shouldLock ? new Date(Date.now()+15*60*1000).toISOString() : null;
      await supabase.from("telegram_auth_security").upsert({
        tenant_id:tenant.id,
        failed_attempts:shouldLock ? 0 : failed,
        locked_until:lockedUntil,
        last_failed_at:new Date().toISOString(),
        updated_at:new Date().toISOString()
      });
      if (shouldLock) return json(req,{ok:false,error:"pin_locked",retry_after_seconds:900},429);
      return json(req,{ok:false,error:"invalid_pin",attempts_remaining:5-failed},401);
    }

    await supabase.from("telegram_auth_security").upsert({
      tenant_id:tenant.id,failed_attempts:0,locked_until:null,updated_at:new Date().toISOString()
    });
    const token = await makeSession(tenant.id,Number(user.id),masterSecret);
    return json(req,{ok:true,token});
  }

  const session = await readSession(req,masterSecret);
  if (!session) return json(req,{ok:false,error:"session_required"},401);
  const tenantQ = await supabase.from("telegram_tenants").select("*").eq("id",session.tid).eq("telegram_user_id",session.uid).maybeSingle();
  if (tenantQ.error) throw tenantQ.error;
  const tenant = tenantQ.data;
  if (!tenant) return json(req,{ok:false,error:"tenant_not_found"},404);

  if (action === "status" && req.method === "GET") {
    const [me, rulesCount, seenCount, logsCount, mediaCount, reviewCount, connectionRows, basicPlanQ, proPlanQ] = await Promise.all([
      telegram("getMe",{},botToken),
      supabase.from("telegram_auto_reply_rules").select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id),
      supabase.from("telegram_seen_chats").select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id),
      supabase.from("telegram_reply_logs").select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id),
      supabase.from("telegram_media_library").select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id),
      supabase.from("telegram_review_queue").select("*",{count:"exact",head:true}).eq("tenant_id",tenant.id).eq("status","pending"),
      supabase.from("telegram_business_connections").select("*").eq("tenant_id",tenant.id).eq("is_enabled",true),
      supabase.from("telegram_plans").select("*").eq("code","basic").maybeSingle(),
      supabase.from("telegram_plans").select("*").eq("code","pro").maybeSingle()
    ]);
    const autoEnabled = await getTenantSetting(supabase,tenant.id,"auto_reply_enabled",true);
    const access = await getTenantAccess(supabase,tenant);
    const referral = await getReferralSummary(supabase,tenant);
    const daysLeft = Math.max(0,Math.ceil((new Date(tenant.trial_ends_at).getTime()-Date.now())/86400000));
    return json(req,{ok:true,bot:sanitizeBotInfo(me?.result),auto_reply_enabled:autoEnabled,
      business_connected:(connectionRows.data??[]).length>0,access,
      tenant:{display_name:tenant.display_name,subscription_status:tenant.subscription_status,
        trial_ends_at:tenant.trial_ends_at,trial_days_left:daysLeft,is_platform_owner:tenant.is_platform_owner,
        plan_code:tenant.plan_code,referral_bonus_until:tenant.referral_bonus_until,
        referral_bonus_seconds:Number(tenant.referral_bonus_seconds??0)},
      plans:[basicPlanQ.data,proPlanQ.data].filter(Boolean).map((p:any)=>({
        code:p.code,name:p.name,currency:p.currency,monthly_price_minor:p.monthly_price_minor,
        usd_price_cents:p.usd_price_cents,stars_price:p.stars_price,trial_days:p.trial_days,
        max_media_items:p.max_media_items,features:p.features
      })),
      referral,
      stats:{rules:rulesCount.count??0,seen_chats:seenCount.count??0,replies:logsCount.count??0,
        media:mediaCount.count??0,pending_reviews:reviewCount.count??0}});
  }

  if (action === "rules" && req.method === "GET") {
    const q = await supabase.from("telegram_auto_reply_rules").select("*")
      .eq("tenant_id",tenant.id).order("priority",{ascending:true}).order("id",{ascending:true});
    if (q.error) throw q.error;
    return json(req,{ok:true,rules:q.data??[]});
  }
  if (action === "media" && req.method === "GET") {
    const q = await supabase.from("telegram_media_library").select("*")
      .eq("tenant_id",tenant.id).eq("enabled",true).order("created_at",{ascending:false});
    if (q.error) throw q.error;
    return json(req,{ok:true,media:q.data??[]});
  }
  if (action === "reviews" && req.method === "GET") {
    const q = await supabase.from("telegram_review_queue").select("*")
      .eq("tenant_id",tenant.id).order("created_at",{ascending:false}).limit(50);
    if (q.error) throw q.error;
    return json(req,{ok:true,reviews:q.data??[]});
  }
  if (action === "logs" && req.method === "GET") {
    const q = await supabase.from("telegram_reply_logs")
      .select("id,chat_id,incoming_text,matched_rule_id,reply_text,reply_type,reply_media_id,status,created_at")
      .eq("tenant_id",tenant.id).order("created_at",{ascending:false}).limit(50);
    if (q.error) throw q.error;
    return json(req,{ok:true,logs:q.data??[]});
  }

  if (action === "setting" && req.method === "POST") {
    const body = await req.json();
    if (body?.key !== "auto_reply_enabled" || typeof body?.value !== "boolean")
      return json(req,{ok:false,error:"invalid_setting"},400);
    await setTenantSetting(supabase,tenant.id,"auto_reply_enabled",body.value);
    return json(req,{ok:true,auto_reply_enabled:body.value});
  }

  if (action === "owner_stats" && req.method === "GET") {
    if (!tenant.is_platform_owner) return json(req,{ok:false,error:"forbidden"},403);
    const [tenantsQ,trialsQ,activeQ,qualifiedQ,bonusQ] = await Promise.all([
      supabase.from("telegram_tenants").select("*",{count:"exact",head:true}),
      supabase.from("telegram_tenants").select("*",{count:"exact",head:true}).eq("subscription_status","trial"),
      supabase.from("telegram_tenants").select("*",{count:"exact",head:true}).eq("subscription_status","active"),
      supabase.from("telegram_referrals").select("*",{count:"exact",head:true}).eq("status","qualified"),
      supabase.from("telegram_referral_bonus_events").select("seconds_added")
    ]);
    if (tenantsQ.error) throw tenantsQ.error;
    if (trialsQ.error) throw trialsQ.error;
    if (activeQ.error) throw activeQ.error;
    if (qualifiedQ.error) throw qualifiedQ.error;
    if (bonusQ.error) throw bonusQ.error;
    const bonusSeconds = (bonusQ.data??[]).reduce((n:number,r:any)=>n+Number(r.seconds_added??0),0);
    return json(req,{ok:true,stats:{
      total_users:Math.max(0,(tenantsQ.count??0)-1),
      trial_users:Math.max(0,(trialsQ.count??0)-(tenant.subscription_status==="trial"?1:0)),
      active_paid_or_owner:activeQ.count??0,
      qualified_referrals:qualifiedQ.count??0,
      referral_bonus_hours_issued:Math.floor(bonusSeconds/3600)
    }});
  }

  if (action === "referral_claim" && req.method === "POST") {
    if (tenant.is_platform_owner) return json(req,{ok:false,error:"owner_does_not_need_bonus"},400);
    const currentAccess = await getTenantAccess(supabase,tenant);
    if (currentAccess.allowed && currentAccess.source !== "referral_bonus") {
      return json(req,{ok:false,error:"normal_access_still_active"},409);
    }
    if (currentAccess.source === "referral_bonus") {
      return json(req,{ok:false,error:"bonus_already_active",expires_at:currentAccess.expires_at},409);
    }

    const freshQ = await supabase.from("telegram_tenants").select("*").eq("id",tenant.id).maybeSingle();
    if (freshQ.error) throw freshQ.error;
    const fresh = freshQ.data;
    const available = Number(fresh?.referral_bonus_seconds ?? 0);
    if (available < 3600) return json(req,{ok:false,error:"not_enough_referral_bonus"},400);

    const until = new Date(Date.now()+3600_000).toISOString();
    const q = await supabase.from("telegram_tenants").update({
      referral_bonus_seconds:available-3600,
      referral_bonus_until:until,
      updated_at:new Date().toISOString()
    }).eq("id",tenant.id);
    if (q.error) throw q.error;
    return json(req,{ok:true,bonus_until:until,remaining_seconds:available-3600});
  }

  if (action === "rule" && req.method === "POST") {
    const body = await req.json();
    const operation = String(body?.action ?? "");
    const id = Number(body?.id);
    const access = await getTenantAccess(supabase,tenant);

    if (operation === "toggle") {
      if (!Number.isFinite(id) || typeof body?.enabled !== "boolean") return json(req,{ok:false,error:"invalid_rule"},400);
      if (body.enabled) {
        if (!access.allowed) return json(req,{ok:false,error:"subscription_required"},402);
        const owned = await supabase.from("telegram_auto_reply_rules").select("*")
          .eq("id",id).eq("tenant_id",tenant.id).maybeSingle();
        if (owned.error) throw owned.error;
        if (!owned.data) return json(req,{ok:false,error:"rule_not_found"},404);
        if (!ruleAllowedForAccess(owned.data,access)) return json(req,{ok:false,error:"upgrade_to_pro"},403);
      }
      const q = await supabase.from("telegram_auto_reply_rules")
        .update({enabled:body.enabled,updated_at:new Date().toISOString()})
        .eq("id",id).eq("tenant_id",tenant.id);
      if (q.error) throw q.error;
      return json(req,{ok:true});
    }

    if (operation === "delete") {
      if (!Number.isFinite(id)) return json(req,{ok:false,error:"invalid_rule"},400);
      const q = await supabase.from("telegram_auto_reply_rules").delete().eq("id",id).eq("tenant_id",tenant.id);
      if (q.error) throw q.error;
      return json(req,{ok:true});
    }

    if (operation === "create" || operation === "update") {
      const matchType = String(body?.match_type ?? "");
      const replyType = String(body?.reply_type ?? "text");
      const replyText = String(body?.reply_text ?? "").trim();
      const mediaId = body?.media_id ? String(body.media_id) : null;
      if (!MATCH_TYPES.has(matchType) || !REPLY_TYPES.has(replyType))
        return json(req,{ok:false,error:"invalid_rule"},400);
      if (!access.allowed) return json(req,{ok:false,error:"subscription_required"},402);

      const requestedRule = {
        match_type:matchType,reply_type:replyType,media_id:mediaId,
        next_rule_id:body?.next_rule_id ? Number(body.next_rule_id) : null,
        notify_admin:body?.notify_admin===true
      };
      if (!ruleAllowedForAccess(requestedRule,access))
        return json(req,{ok:false,error:"upgrade_to_pro"},403);
      if (replyType === "text" && !replyText && !body?.notify_admin)
        return json(req,{ok:false,error:"reply_required"},400);

      if (mediaId) {
        const mq = await supabase.from("telegram_media_library").select("id")
          .eq("id",mediaId).eq("tenant_id",tenant.id).maybeSingle();
        if (mq.error) throw mq.error;
        if (!mq.data) return json(req,{ok:false,error:"media_not_owned"},403);
      }

      const nextId = body?.next_rule_id ? Number(body.next_rule_id) : null;
      if (nextId) {
        const nq = await supabase.from("telegram_auto_reply_rules").select("id")
          .eq("id",nextId).eq("tenant_id",tenant.id).maybeSingle();
        if (nq.error) throw nq.error;
        if (!nq.data) return json(req,{ok:false,error:"next_rule_not_owned"},403);
      }

      const values:any = {
        tenant_id:tenant.id, enabled:body.enabled !== false, match_type:matchType,
        trigger_text:["new_chat","default","photo","video","pdf","document","voice","audio","any_media","flow_step"].includes(matchType)
          ? null : String(body.trigger_text ?? "").trim(),
        reply_text:replyText || null, reply_type:replyType, media_id:mediaId, next_rule_id:nextId,
        notify_admin:body?.notify_admin===true,
        approval_reply_text:String(body?.approval_reply_text ?? "").trim() || null,
        rejection_reply_text:String(body?.rejection_reply_text ?? "").trim() || null,
        priority:Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100,
        updated_at:new Date().toISOString(),
      };
      if (operation === "create") {
        const q = await supabase.from("telegram_auto_reply_rules").insert(values).select().single();
        if (q.error) throw q.error;
        return json(req,{ok:true,rule:q.data});
      }
      if (!Number.isFinite(id)) return json(req,{ok:false,error:"invalid_rule"},400);
      const q = await supabase.from("telegram_auto_reply_rules").update(values)
        .eq("id",id).eq("tenant_id",tenant.id).select().single();
      if (q.error) throw q.error;
      return json(req,{ok:true,rule:q.data});
    }
    return json(req,{ok:false,error:"unknown_action"},400);
  }

  if (action === "reset_seen" && req.method === "POST") {
    const q = await supabase.from("telegram_seen_chats").delete().eq("tenant_id",tenant.id);
    if (q.error) throw q.error;
    return json(req,{ok:true});
  }

  return json(req,{ok:false,error:"not_found"},404);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok",{headers:cors(req)});

  const masterSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!masterSecret || !botToken || !supabaseUrl || !serviceRoleKey)
    return json(req,{ok:false,error:"server_not_configured"},500);

  const supabase = createClient(supabaseUrl,serviceRoleKey,{
    auth:{persistSession:false,autoRefreshToken:false}
  });
  const url = new URL(req.url);
  const publicAction = url.searchParams.get("public");

  try {
    if (publicAction) return await publicApi(req,publicAction,supabase,botToken,masterSecret);

    const telegramSecret = await sha256Hex(masterSecret);
    if (req.method !== "POST") return json(req,{ok:false,error:"method_not_allowed"},405);
    if (req.headers.get("x-telegram-bot-api-secret-token") !== telegramSecret)
      return json(req,{ok:false,error:"unauthorized"},401);

    const update = await req.json();

    if (update?.business_connection?.id && update?.business_connection?.user?.id) {
      const bc = update.business_connection;
      const tenant = await ensureTenant(supabase,bc.user);
      await supabase.from("telegram_business_connections").upsert({
        business_connection_id:String(bc.id), tenant_id:tenant.id,
        telegram_user_id:Number(bc.user.id), is_enabled:bc.is_enabled !== false,
        rights:bc.rights || null, updated_at:new Date().toISOString()
      });
      if (bc.is_enabled !== false) {
        const freshTenantQ = await supabase.from("telegram_tenants").select("*").eq("id",tenant.id).maybeSingle();
        if (freshTenantQ.error) throw freshTenantQ.error;
        await tryQualifyReferral(supabase,freshTenantQ.data);
      }
      const notifyChat = await getTenantSetting(supabase,tenant.id,"notification_chat_id",null);
      if (notifyChat) {
        await telegram("sendMessage",{chat_id:notifyChat,
          text:bc.is_enabled === false
            ? "⚠️ Auto Replyer Bot was disconnected from your Telegram profile."
            : "✅ Auto Replyer Bot is now connected to your Telegram profile. Your private rules can start working."
        },botToken);
      }
      return json(req,{ok:true});
    }

    if (update?.callback_query) {
      const handled = await v3HandleReviewCallback(update.callback_query,supabase,botToken);
      if (!handled && update.callback_query?.data === "open_library") {
        await telegram("answerCallbackQuery",{callback_query_id:update.callback_query.id,text:"Send /library in this chat."},botToken);
      }
      return json(req,{ok:true});
    }

    if (update?.message && !update?.business_message) {
      await v3HandleDirectBotMessage(update.message,supabase,botToken);
      return json(req,{ok:true});
    }

    const message = update?.business_message;
    if (!message?.business_connection_id) return json(req,{ok:true});
    if (message?.from?.is_bot || message?.sender_business_bot) return json(req,{ok:true});

    const resolved = await tenantForConnection(supabase,String(message.business_connection_id),botToken);
    if (!resolved) return json(req,{ok:true,skipped:"unknown_connection"});
    const tenant = resolved.tenant;
    const connectionId = String(message.business_connection_id);

    const access = await getTenantAccess(supabase,tenant);
    if (!access.allowed)
      return json(req,{ok:true,skipped:"subscription_inactive"});

    const enabled = await getTenantSetting(supabase,tenant.id,"auto_reply_enabled",true);
    if (enabled !== true) return json(req,{ok:true,skipped:"disabled"});

    const chatId = Number(message.chat?.id);
    if (!Number.isFinite(chatId)) return json(req,{ok:true});
    if (Number(message?.from?.id) === Number(tenant.telegram_user_id)) return json(req,{ok:true});

    const incomingText = String(message.text ?? message.caption ?? "").trim();
    const normalized = normalizeMessageText(incomingText);
    const media = getIncomingMedia(message);

    if (media) {
      const expQ = await supabase.from("telegram_review_expectations").select("*")
        .eq("tenant_id",tenant.id).eq("business_connection_id",connectionId).eq("chat_id",chatId).maybeSingle();
      if (expQ.error) throw expQ.error;
      const expectation = expQ.data;
      if (expectation) {
        const expired = new Date(expectation.expires_at).getTime() < Date.now();
        if (expired) {
          await supabase.from("telegram_review_expectations").delete()
            .eq("tenant_id",tenant.id).eq("business_connection_id",connectionId).eq("chat_id",chatId);
        } else {
          const ruleQ = await supabase.from("telegram_auto_reply_rules").select("*")
            .eq("id",expectation.source_rule_id).eq("tenant_id",tenant.id).eq("enabled",true).maybeSingle();
          if (ruleQ.error) throw ruleQ.error;
          if (ruleQ.data?.notify_admin && ruleAllowedForAccess(ruleQ.data,access)) {
            await v3NotifyReview(ruleQ.data,tenant,message,media,connectionId,supabase,botToken);
            await supabase.from("telegram_review_expectations").delete()
              .eq("tenant_id",tenant.id).eq("business_connection_id",connectionId).eq("chat_id",chatId);
            await supabase.from("telegram_reply_logs").insert({
              tenant_id:tenant.id,business_connection_id:connectionId,chat_id:chatId,
              telegram_message_id:message.message_id ?? null,
              incoming_text:"["+media.type+" submitted for review]",
              matched_rule_id:ruleQ.data.id,reply_text:null,reply_type:"review",reply_media_id:null,status:"sent"
            });
            return json(req,{ok:true,review_queued:true});
          }
        }
      }
    }

    const seenQ = await supabase.from("telegram_seen_chats").select("chat_id")
      .eq("tenant_id",tenant.id).eq("business_connection_id",connectionId).eq("chat_id",chatId).maybeSingle();
    if (seenQ.error) throw seenQ.error;
    const isNewChat = !seenQ.data;
    if (isNewChat) {
      const ins = await supabase.from("telegram_seen_chats").insert({
        tenant_id:tenant.id,business_connection_id:connectionId,chat_id:chatId
      });
      if (ins.error && ins.error.code !== "23505") throw ins.error;
    }

    let matchedRule:any = null;
    const stateQ = await supabase.from("telegram_conversation_states").select("*")
      .eq("tenant_id",tenant.id).eq("business_connection_id",connectionId).eq("chat_id",chatId).maybeSingle();
    if (stateQ.error) throw stateQ.error;
    if (stateQ.data?.next_rule_id) {
      const expired = stateQ.data.expires_at && new Date(stateQ.data.expires_at).getTime() < Date.now();
      if (!expired) {
        const nextQ = await supabase.from("telegram_auto_reply_rules").select("*")
          .eq("id",stateQ.data.next_rule_id).eq("tenant_id",tenant.id).eq("enabled",true).maybeSingle();
        if (nextQ.error) throw nextQ.error;
        if (nextQ.data && ruleAllowedForAccess(nextQ.data,access)) matchedRule = nextQ.data;
      }
      await supabase.from("telegram_conversation_states").delete()
        .eq("tenant_id",tenant.id).eq("business_connection_id",connectionId).eq("chat_id",chatId);
    }

    if (!matchedRule) {
      const rulesQ = await supabase.from("telegram_auto_reply_rules").select("*")
        .eq("tenant_id",tenant.id).eq("enabled",true)
        .order("priority",{ascending:true}).order("id",{ascending:true});
      if (rulesQ.error) throw rulesQ.error;
      for (const rule of rulesQ.data ?? []) {
        if (rule.match_type === "flow_step") continue;
        if (!ruleAllowedForAccess(rule,access)) continue;
        const trigger = normalizeMessageText(rule.trigger_text);
        const matches =
          (rule.match_type === "new_chat" && isNewChat) ||
          (rule.match_type === "exact" && normalized === trigger) ||
          (rule.match_type === "contains" && trigger.length > 0 && normalized.includes(trigger)) ||
          (rule.match_type === "starts_with" && trigger.length > 0 && normalized.startsWith(trigger)) ||
          (rule.match_type === "ends_with" && trigger.length > 0 && normalized.endsWith(trigger)) ||
          mediaMatches(rule.match_type,media) || rule.match_type === "default";
        if (matches) { matchedRule = rule; break; }
      }
    }

    if (matchedRule)
      await v3ExecuteRule(matchedRule,tenant,message,media,connectionId,supabase,botToken,incomingText);

    return json(req,{ok:true});
  } catch (error) {
    console.error("Auto Replyer Bot error",error);
    return json(req,{ok:true});
  }
});
