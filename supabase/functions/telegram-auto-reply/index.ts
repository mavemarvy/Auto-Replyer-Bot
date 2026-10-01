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
    "Access-Control-Allow-Headers": "content-type, x-admin-secret, x-telegram-bot-api-secret-token",
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
  await notifyAdminForReview(rule, message, media, connectionId, supabase, botToken);

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });

  const masterSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!masterSecret || !botToken || !supabaseUrl || !serviceRoleKey) {
    return json(req, { ok: false, error: "server_not_configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const url = new URL(req.url);
  const telegramSecret = await sha256Hex(masterSecret);
  const webhookUrl = `${supabaseUrl}/functions/v1/telegram-auto-reply`;

  const adminAction = url.searchParams.get("admin");
  if (adminAction) {
    if (req.headers.get("x-admin-secret") !== masterSecret) {
      return json(req, { ok: false, error: "unauthorized" }, 401);
    }
    try {
      if (req.method === "POST" && adminAction === "register") {
        const setResult = await telegram("setWebhook", {
          url: webhookUrl,
          secret_token: telegramSecret,
          allowed_updates: [
            "business_connection","business_message","edited_business_message","deleted_business_messages",
            "message","callback_query"
          ],
          drop_pending_updates: false,
        }, botToken);
        const info = await telegram("getWebhookInfo", {}, botToken);
        return json(req, { ok: true, registered: Boolean(setResult?.result), webhook: sanitizeWebhookInfo(info?.result) });
      }

      if (req.method === "GET" && adminAction === "status") {
        const [me, webhookInfo, rulesCount, seenCount, logsCount, mediaCount, reviewCount, setting] = await Promise.all([
          telegram("getMe", {}, botToken),
          telegram("getWebhookInfo", {}, botToken),
          supabase.from("telegram_auto_reply_rules").select("*", { count: "exact", head: true }),
          supabase.from("telegram_seen_chats").select("*", { count: "exact", head: true }),
          supabase.from("telegram_reply_logs").select("*", { count: "exact", head: true }),
          supabase.from("telegram_media_library").select("*", { count: "exact", head: true }),
          supabase.from("telegram_review_queue").select("*", { count: "exact", head: true }).eq("status", "pending"),
          supabase.from("telegram_settings").select("value").eq("key", "auto_reply_enabled").maybeSingle(),
        ]);
        return json(req, {
          ok: true,
          bot: sanitizeBotInfo(me?.result),
          webhook: sanitizeWebhookInfo(webhookInfo?.result),
          auto_reply_enabled: setting.data?.value === true,
          stats: {
            rules: rulesCount.count ?? 0,
            seen_chats: seenCount.count ?? 0,
            replies: logsCount.count ?? 0,
            media: mediaCount.count ?? 0,
            pending_reviews: reviewCount.count ?? 0,
          },
        });
      }

      if (req.method === "GET" && adminAction === "rules") {
        const { data, error } = await supabase
          .from("telegram_auto_reply_rules")
          .select("*")
          .order("priority", { ascending: true })
          .order("id", { ascending: true });
        if (error) throw error;
        return json(req, { ok: true, rules: data ?? [] });
      }

      if (req.method === "GET" && adminAction === "media") {
        const { data, error } = await supabase
          .from("telegram_media_library")
          .select("*")
          .eq("enabled", true)
          .order("created_at", { ascending: false });
        if (error) throw error;
        return json(req, { ok: true, media: data ?? [] });
      }

      if (req.method === "GET" && adminAction === "reviews") {
        const { data, error } = await supabase
          .from("telegram_review_queue")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        return json(req, { ok: true, reviews: data ?? [] });
      }

      if (req.method === "GET" && adminAction === "logs") {
        const { data, error } = await supabase
          .from("telegram_reply_logs")
          .select("id,chat_id,incoming_text,matched_rule_id,reply_text,reply_type,reply_media_id,status,created_at")
          .order("created_at", { ascending: false })
          .limit(50);
        if (error) throw error;
        return json(req, { ok: true, logs: data ?? [] });
      }

      if (req.method === "POST" && adminAction === "setting") {
        const body = await req.json();
        if (body?.key !== "auto_reply_enabled" || typeof body?.value !== "boolean") {
          return json(req, { ok: false, error: "invalid_setting" }, 400);
        }
        await setSetting(supabase, "auto_reply_enabled", body.value);
        return json(req, { ok: true, auto_reply_enabled: body.value });
      }

      if (req.method === "POST" && adminAction === "rule") {
        const body = await req.json();
        const action = String(body?.action ?? "");

        if (action === "toggle") {
          const id = Number(body?.id);
          if (!Number.isFinite(id) || typeof body?.enabled !== "boolean") {
            return json(req, { ok: false, error: "invalid_rule" }, 400);
          }
          const { error } = await supabase
            .from("telegram_auto_reply_rules")
            .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
            .eq("id", id);
          if (error) throw error;
          return json(req, { ok: true });
        }

        if (action === "delete") {
          const id = Number(body?.id);
          if (!Number.isFinite(id)) return json(req, { ok: false, error: "invalid_rule" }, 400);
          const { error } = await supabase.from("telegram_auto_reply_rules").delete().eq("id", id);
          if (error) throw error;
          return json(req, { ok: true });
        }

        if (action === "create" || action === "update") {
          const id = Number(body?.id);
          const matchType = String(body?.match_type ?? "");
          const replyType = String(body?.reply_type ?? "text");
          const replyText = String(body?.reply_text ?? "").trim();
          const mediaId = body?.media_id ? String(body.media_id) : null;
          if (!MATCH_TYPES.has(matchType) || !REPLY_TYPES.has(replyType)) {
            return json(req, { ok: false, error: "invalid_rule" }, 400);
          }
          if (replyType === "text" && !replyText && !body?.notify_admin) {
            return json(req, { ok: false, error: "reply_required" }, 400);
          }
          if (replyType !== "text" && !mediaId) {
            return json(req, { ok: false, error: "media_required" }, 400);
          }

          const values = {
            enabled: body.enabled !== false,
            match_type: matchType,
            trigger_text: ["new_chat","default","photo","video","pdf","document","voice","audio","any_media","flow_step"].includes(matchType)
              ? null : String(body.trigger_text ?? "").trim(),
            reply_text: replyText || null,
            reply_type: replyType,
            media_id: mediaId,
            next_rule_id: body?.next_rule_id ? Number(body.next_rule_id) : null,
            notify_admin: body?.notify_admin === true,
            approval_reply_text: String(body?.approval_reply_text ?? "").trim() || null,
            rejection_reply_text: String(body?.rejection_reply_text ?? "").trim() || null,
            priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100,
            updated_at: new Date().toISOString(),
          };

          if (action === "create") {
            const { data, error } = await supabase
              .from("telegram_auto_reply_rules")
              .insert(values)
              .select()
              .single();
            if (error) throw error;
            return json(req, { ok: true, rule: data });
          }

          if (!Number.isFinite(id)) return json(req, { ok: false, error: "invalid_rule" }, 400);
          const { data, error } = await supabase
            .from("telegram_auto_reply_rules")
            .update(values)
            .eq("id", id)
            .select()
            .single();
          if (error) throw error;
          return json(req, { ok: true, rule: data });
        }

        return json(req, { ok: false, error: "unknown_action" }, 400);
      }

      if (req.method === "POST" && adminAction === "reset_seen") {
        const { error } = await supabase.from("telegram_seen_chats").delete().neq("chat_id", 0);
        if (error) throw error;
        return json(req, { ok: true });
      }

      return json(req, { ok: false, error: "not_found" }, 404);
    } catch (error) {
      console.error("Admin API error", error);
      return json(req, { ok: false, error: "server_error" }, 500);
    }
  }

  if (req.method !== "POST") return json(req, { ok: false, error: "method_not_allowed" }, 405);
  if (req.headers.get("x-telegram-bot-api-secret-token") !== telegramSecret) {
    return json(req, { ok: false, error: "unauthorized" }, 401);
  }

  try {
    const update = await req.json();

    if (update?.business_connection?.user?.id) {
      await setSetting(supabase, "owner_telegram_user_id", update.business_connection.user.id);
      return json(req, { ok: true });
    }

    if (update?.callback_query) {
      await handleReviewCallback(update.callback_query, supabase, botToken);
      return json(req, { ok: true });
    }

    if (update?.message && !update?.business_message) {
      await handleDirectBotMessage(update.message, supabase, botToken);
      return json(req, { ok: true });
    }

    const message = update?.business_message;
    if (!message?.business_connection_id) return json(req, { ok: true });
    if (message?.from?.is_bot || message?.sender_business_bot) return json(req, { ok: true });

    const enabled = await getSetting(supabase, "auto_reply_enabled");
    if (enabled !== true) return json(req, { ok: true, skipped: "disabled" });

    const connectionId = String(message.business_connection_id);
    const chatId = Number(message.chat?.id);
    if (!Number.isFinite(chatId)) return json(req, { ok: true });

    const connection = await telegram("getBusinessConnection", {
      business_connection_id: connectionId,
    }, botToken);
    const ownerId = connection?.result?.user?.id;
    if (ownerId) await setSetting(supabase, "owner_telegram_user_id", ownerId);
    if (ownerId && Number(message?.from?.id) === Number(ownerId)) return json(req, { ok: true });

    const incomingText = String(message.text ?? message.caption ?? "").trim();
    const normalized = normalizeMessageText(incomingText);
    const media = getIncomingMedia(message);

    const { data: seen, error: seenError } = await supabase
      .from("telegram_seen_chats")
      .select("chat_id")
      .eq("business_connection_id", connectionId)
      .eq("chat_id", chatId)
      .maybeSingle();
    if (seenError) throw seenError;
    const isNewChat = !seen;
    if (isNewChat) {
      const { error } = await supabase.from("telegram_seen_chats").insert({
        business_connection_id: connectionId,
        chat_id: chatId,
      });
      if (error && error.code !== "23505") throw error;
    }

    let matchedRule: any = null;

    const { data: state, error: stateError } = await supabase
      .from("telegram_conversation_states")
      .select("*")
      .eq("business_connection_id", connectionId)
      .eq("chat_id", chatId)
      .maybeSingle();
    if (stateError) throw stateError;

    if (state?.next_rule_id) {
      const expired = state.expires_at && new Date(state.expires_at).getTime() < Date.now();
      if (!expired) {
        const { data: nextRule, error } = await supabase
          .from("telegram_auto_reply_rules")
          .select("*")
          .eq("id", state.next_rule_id)
          .eq("enabled", true)
          .maybeSingle();
        if (error) throw error;
        if (nextRule) matchedRule = nextRule;
      }
      await supabase
        .from("telegram_conversation_states")
        .delete()
        .eq("business_connection_id", connectionId)
        .eq("chat_id", chatId);
    }

    if (!matchedRule) {
      const { data: rules, error } = await supabase
        .from("telegram_auto_reply_rules")
        .select("*")
        .eq("enabled", true)
        .order("priority", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;

      for (const rule of rules ?? []) {
        if (rule.match_type === "flow_step") continue;
        const trigger = normalizeMessageText(rule.trigger_text);
        const matches =
          (rule.match_type === "new_chat" && isNewChat) ||
          (rule.match_type === "exact" && normalized === trigger) ||
          (rule.match_type === "contains" && trigger.length > 0 && normalized.includes(trigger)) ||
          (rule.match_type === "starts_with" && trigger.length > 0 && normalized.startsWith(trigger)) ||
          (rule.match_type === "ends_with" && trigger.length > 0 && normalized.endsWith(trigger)) ||
          mediaMatches(rule.match_type, media) ||
          rule.match_type === "default";
        if (matches) {
          matchedRule = rule;
          break;
        }
      }
    }

    if (matchedRule) {
      await executeRule(matchedRule, message, media, connectionId, supabase, botToken, incomingText);
    }

    return json(req, { ok: true });
  } catch (error) {
    console.error("Telegram webhook error", error);
    return json(req, { ok: true });
  }
});