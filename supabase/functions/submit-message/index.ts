import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { name, body, token, mediaUrl, mediaType } = await req.json();

    // Verify hCaptcha
    const captchaRes = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${Deno.env.get("HCAPTCHA_SECRET")}&response=${token}`
    });
    const captcha = await captchaRes.json();
    if (!captcha.success) {
      return new Response(JSON.stringify({ error: "Invalid captcha" }), { 
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Require at least a name and body message
    if (!name || !body) {
      return new Response(JSON.stringify({ error: "Missing name or message" }), { 
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { error } = await supabase.from("messages").insert({
      name,
      body: body || null,
      media_url: mediaUrl || null,
      media_type: mediaType || null,
      status: "pending"
    });

    if (error) {
      console.error("DB error:", error);
      return new Response(JSON.stringify({ error: "Database error" }), { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Notify admin
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY")}`
      },
      body: JSON.stringify({
        from: "memorial@yourdomain.com",
        to: "you@youremail.com",
        subject: `New ${mediaType || 'text'} submission from ${name}`,
        text: `${name} submitted a message.${body ? "\n\nMessage: " + body : ""}${mediaUrl ? "\n\nMedia: " + mediaUrl : ""}`
      })
    }).catch(err => console.error("Email error:", err));

    return new Response(JSON.stringify({ success: true }), { 
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});