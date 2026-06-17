import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-admin-token, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getAdminToken(req: Request) {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  return req.headers.get("x-admin-token") || bearer || "";
}

function isAuthorized(req: Request) {
  const expected = Deno.env.get("ADMIN_TOKEN");
  return Boolean(expected && getAdminToken(req) === expected);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!isAuthorized(req)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      const requestedStatus = url.searchParams.get("status") || "pending";
      const allowedStatuses = new Set(["pending", "approved", "denied"]);

      if (!allowedStatuses.has(requestedStatus)) {
        return json({ error: "Invalid status filter" }, 400);
      }

      const { data, error } = await supabase
        .from("messages")
        .select("id, name, body, media_url, media_type, status, created_at")
        .eq("status", requestedStatus)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Admin fetch error:", error);
        return json({ error: "Could not load pending messages" }, 500);
      }

      const messages = await Promise.all(
        (data ?? []).map(async (msg) => {
          if (!msg.media_url) return msg;

          const { data: signed } = await supabase.storage
            .from("memorial-media")
            .createSignedUrl(msg.media_url, 3600);

          return { ...msg, signedUrl: signed?.signedUrl || null };
        }),
      );

      return json({ messages });
    }

    if (req.method === "PATCH") {
      const { id, action } = await req.json();
      const status = action === "approve" ? "approved" : action === "deny" ? "denied" : null;

      if (!id || !status) {
        return json({ error: "Expected an id and action of approve or deny" }, 400);
      }

      const { data, error } = await supabase
        .from("messages")
        .update({ status })
        .eq("id", id)
        .select("id, status")
        .single();

      if (error) {
        console.error("Admin update error:", error);
        return json({ error: "Could not update message" }, 500);
      }

      return json({ success: true, status: data.status });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("Admin function error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
