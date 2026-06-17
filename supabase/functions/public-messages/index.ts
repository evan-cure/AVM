import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  const { data, error } = await supabase
    .from("messages")
    .select("name, body, media_url, media_type, created_at")
    .eq("status", "approved")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Public messages fetch error:", error);
    return json({ error: "Could not load messages" }, 500);
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
});
