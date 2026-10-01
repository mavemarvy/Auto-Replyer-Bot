import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

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

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expectedSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!expectedSecret || !botToken || !supabaseUrl || !serviceRoleKey) {
    console.error("Missing required environment variables");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (receivedSecret !== expectedSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  try {
    const update = await req.json();
    const message = update?.business_message;

    if (!message?.business_connection_id || typeof message?.text !== "string") {
      return json({ ok: true });
    }

    if (message?.from?.is_bot || message?.sender_business_bot) {
      return json({ ok: true });
    }

    const connectionId = String(message.business_connection_id);
    const chatId = Number(message?.chat?.id);
    if (!Number.isFinite(chatId)) return json({ ok: true });

    const connection = await telegram("getBusinessConnection", {
      business_connection_id: connectionId,
    }, botToken);

    const ownerId = connection?.result?.user?.id;
    if (ownerId && message?.from?.id === ownerId) {
      return json({ ok: true });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

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
        .insert({
          business_connection_id: connectionId,
          chat_id: chatId,
        });

      if (insertError && insertError.code !== "23505") throw insertError;
    }

    const { data: rules, error: rulesError } = await supabase
      .from("telegram_auto_reply_rules")
      .select("id,match_type,trigger_text,reply_text,priority")
      .eq("enabled", true)
      .order("priority", { ascending: true })
      .order("id", { ascending: true });

    if (rulesError) throw rulesError;

    const incoming = message.text.trim().toLowerCase();
    let reply: string | null = null;

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
        reply = String(rule.reply_text);
        break;
      }
    }

    if (reply) {
      await telegram("sendMessage", {
        business_connection_id: connectionId,
        chat_id: chatId,
        text: reply,
      }, botToken);
    }

    return json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error", error);
    return json({ ok: true });
  }
});