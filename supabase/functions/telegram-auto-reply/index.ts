import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const MATCH_TYPES = new Set(["new_chat", "exact", "contains", "starts_with", "ends_with", "default"]);
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
    has_custom_certificate: result.has_custom_certificate ?? false,
    pending_update_count: result.pending_update_count ?? 0,
    last_error_date: result.last_error_date ?? null,
    last_error_message: result.last_error_message ?? null,
    max_connections: result.max_connections ?? null,
    allowed_updates: result.allowed_updates ?? [],
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors(req) });
  }

  const masterSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!masterSecret || !botToken || !supabaseUrl || !serviceRoleKey) {
    console.error("Missing required environment variables");
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
            "business_connection",
            "business_message",
            "edited_business_message",
            "deleted_business_messages",
          ],
          drop_pending_updates: false,
        }, botToken);
        const info = await telegram("getWebhookInfo", {}, botToken);
        return json(req, {
          ok: true,
          registered: Boolean(setResult?.result),
          webhook: sanitizeWebhookInfo(info?.result),
        });
      }

      if (req.method === "GET" && adminAction === "status") {
        const [me, webhookInfo, rulesCount, seenCount, logsCount, setting] = await Promise.all([
          telegram("getMe", {}, botToken),
          telegram("getWebhookInfo", {}, botToken),
          supabase.from("telegram_auto_reply_rules").select("*", { count: "exact", head: true }),
          supabase.from("telegram_seen_chats").select("*", { count: "exact", head: true }),
          supabase.from("telegram_reply_logs").select("*", { count: "exact", head: true }),
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

      if (req.method === "GET" && adminAction === "logs") {
        const { data, error } = await supabase
          .from("telegram_reply_logs")
          .select("id,chat_id,incoming_text,matched_rule_id,reply_text,status,created_at")
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
        const { error } = await supabase
          .from("telegram_settings")
          .upsert({ key: "auto_reply_enabled", value: body.value, updated_at: new Date().toISOString() });
        if (error) throw error;
        return json(req, { ok: true, auto_reply_enabled: body.value });
      }

      if (req.method === "POST" && adminAction === "rule") {
        const body = await req.json();
        const action = String(body?.action ?? "");

        if (action === "create") {
          if (!MATCH_TYPES.has(body?.match_type) || typeof body?.reply_text !== "string" || !body.reply_text.trim()) {
            return json(req, { ok: false, error: "invalid_rule" }, 400);
          }
          const { data, error } = await supabase
            .from("telegram_auto_reply_rules")
            .insert({
              enabled: body.enabled !== false,
              match_type: body.match_type,
              trigger_text: ["new_chat", "default"].includes(body.match_type) ? null : String(body.trigger_text ?? "").trim(),
              reply_text: body.reply_text.trim(),
              priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100,
              updated_at: new Date().toISOString(),
            })
            .select()
            .single();
          if (error) throw error;
          return json(req, { ok: true, rule: data });
        }

        if (action === "update") {
          const id = Number(body?.id);
          if (!Number.isFinite(id) || !MATCH_TYPES.has(body?.match_type) || typeof body?.reply_text !== "string" || !body.reply_text.trim()) {
            return json(req, { ok: false, error: "invalid_rule" }, 400);
          }
          const { data, error } = await supabase
            .from("telegram_auto_reply_rules")
            .update({
              enabled: body.enabled !== false,
              match_type: body.match_type,
              trigger_text: ["new_chat", "default"].includes(body.match_type) ? null : String(body.trigger_text ?? "").trim(),
              reply_text: body.reply_text.trim(),
              priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id)
            .select()
            .single();
          if (error) throw error;
          return json(req, { ok: true, rule: data });
        }

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

  if (req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") !== telegramSecret) {
    return json(req, { ok: false, error: "unauthorized" }, 401);
  }

  try {
    const update = await req.json();
    const message = update?.business_message;

    if (!message?.business_connection_id || typeof message?.text !== "string") {
      return json(req, { ok: true });
    }
    if (message?.from?.is_bot || message?.sender_business_bot) {
      return json(req, { ok: true });
    }

    const { data: setting, error: settingError } = await supabase
      .from("telegram_settings")
      .select("value")
      .eq("key", "auto_reply_enabled")
      .maybeSingle();
    if (settingError) throw settingError;
    if (setting?.value !== true) return json(req, { ok: true, skipped: "disabled" });

    const connectionId = String(message.business_connection_id);
    const chatId = Number(message?.chat?.id);
    if (!Number.isFinite(chatId)) return json(req, { ok: true });

    const connection = await telegram("getBusinessConnection", {
      business_connection_id: connectionId,
    }, botToken);
    const ownerId = connection?.result?.user?.id;
    if (ownerId && message?.from?.id === ownerId) return json(req, { ok: true });

    const { data: seen, error: seenError } = await supabase
      .from("telegram_seen_chats")
      .select("chat_id")
      .eq("business_connection_id", connectionId)
      .eq("chat_id", chatId)
      .maybeSingle();
    if (seenError) throw seenError;

    const isNewChat = !seen;
    if (isNewChat) {
      const { error: insertError } = await supabase
        .from("telegram_seen_chats")
        .insert({ business_connection_id: connectionId, chat_id: chatId });
      if (insertError && insertError.code !== "23505") throw insertError;
    }

    const { data: rules, error: rulesError } = await supabase
      .from("telegram_auto_reply_rules")
      .select("id,match_type,trigger_text,reply_text,priority")
      .eq("enabled", true)
      .order("priority", { ascending: true })
      .order("id", { ascending: true });
    if (rulesError) throw rulesError;

    const incomingOriginal = message.text.trim();
    const incoming = incomingOriginal.toLowerCase();
    let matchedRule: any = null;

    for (const rule of rules ?? []) {
      const trigger = String(rule.trigger_text ?? "").trim().toLowerCase();
      const matches =
        (rule.match_type === "new_chat" && isNewChat) ||
        (rule.match_type === "exact" && incoming === trigger) ||
        (rule.match_type === "contains" && trigger.length > 0 && incoming.includes(trigger)) ||
        (rule.match_type === "starts_with" && trigger.length > 0 && incoming.startsWith(trigger)) ||
        (rule.match_type === "ends_with" && trigger.length > 0 && incoming.endsWith(trigger)) ||
        rule.match_type === "default";
      if (matches) {
        matchedRule = rule;
        break;
      }
    }

    if (matchedRule) {
      await telegram("sendMessage", {
        business_connection_id: connectionId,
        chat_id: chatId,
        text: String(matchedRule.reply_text),
      }, botToken);

      await supabase.from("telegram_reply_logs").insert({
        business_connection_id: connectionId,
        chat_id: chatId,
        telegram_message_id: message.message_id ?? null,
        incoming_text: incomingOriginal,
        matched_rule_id: matchedRule.id,
        reply_text: String(matchedRule.reply_text),
        status: "sent",
      });
    }

    return json(req, { ok: true });
  } catch (error) {
    console.error("Telegram webhook error", error);
    return json(req, { ok: true });
  }
});