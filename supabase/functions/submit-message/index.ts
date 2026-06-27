import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";
import {
  isSafeStoragePath,
  mediaExtension,
  MESSAGE_MEDIA_EXTENSIONS,
} from "../_shared/media.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateSubmittedMedia(mediaUrl: unknown, mediaType: unknown) {
  if (!mediaUrl && !mediaType) return null;
  if (!isSafeStoragePath(mediaUrl)) return "Invalid media path.";
  if (!String(mediaUrl).startsWith("media/")) return "Invalid media path.";

  const extension = mediaExtension(String(mediaUrl));
  if (!MESSAGE_MEDIA_EXTENSIONS.has(extension)) return "Unsupported media file type.";

  const expectedType = extension === "mp4" ? "video" : "image";
  if (mediaType !== expectedType) return "Invalid media type.";

  return null;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const { name, body, token, mediaUrl, mediaType } = await req.json();
    const cleanName = cleanText(name, 100);
    const cleanBody = cleanText(body, 2000);

    // Verify hCaptcha
    const captchaRes = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${Deno.env.get("HCAPTCHA_SECRET")}&response=${token}`
    });
    const captcha = await captchaRes.json();
    if (!captcha.success) {
      return json({ error: "Invalid captcha" }, 400);
    }

    // Require at least a name and body message
    if (!cleanName || !cleanBody) {
      return json({ error: "Missing name or message" }, 400);
    }

    if (cleanBody.length < 10) {
      return json({ error: "Message must be at least 10 characters." }, 400);
    }

    const mediaError = validateSubmittedMedia(mediaUrl, mediaType);
    if (mediaError) {
      return json({ error: mediaError }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    const { error } = await supabase.from("messages").insert({
      name: cleanName,
      body: cleanBody,
      media_url: mediaUrl || null,
      media_type: mediaType || null,
      status: "pending"
    });

    if (error) {
      console.error("DB error:", error);
      return json({ error: "Database error" }, 500);
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
        subject: `New ${mediaType || 'text'} submission from ${cleanName}`,
        text: `${cleanName} submitted a message.${cleanBody ? "\n\nMessage: " + cleanBody : ""}${mediaUrl ? "\n\nMedia: " + mediaUrl : ""}`
      })
    }).catch(err => console.error("Email error:", err));

    return json({ success: true });
  } catch (err) {
    console.error("Function error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
