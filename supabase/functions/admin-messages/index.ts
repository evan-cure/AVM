import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";
import {
  adminMediaType,
  isSafeStoragePath,
  MAX_ADMIN_MEDIA_COUNT,
  MEDIA_BUCKET,
  mediaContentExtension,
  sanitizeFilename,
  signMediaUrl,
  validateAdminMedia,
} from "../_shared/media.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-admin-token, x-client-info, apikey, content-type",
};

const DISAPPROVED_STATUSES = ["denied", "rejected", "disapproved"];

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

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function storagePathFor(file: File) {
  const baseName = sanitizeFilename(file.name).replace(/\.[^.]+$/, "");
  const extension = mediaContentExtension(file);
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `media/admin/${year}/${month}/${crypto.randomUUID()}-${baseName}.${extension}`;
}

async function listMessages(supabase: any, status: string) {
  const allowedStatuses = new Set(["pending", "approved", "denied"]);

  if (!allowedStatuses.has(status)) {
    return json({ error: "Invalid status filter" }, 400);
  }

  const query = supabase
    .from("messages")
    .select("id, name, body, media_url, media_type, status, created_at");

  const { data, error } = await (status === "denied"
    ? query.in("status", DISAPPROVED_STATUSES)
    : query.eq("status", status))
    .order("created_at", { ascending: status === "pending" });

  if (error) {
    console.error("Admin fetch error:", error);
    return json({ error: "Could not load messages" }, 500);
  }

  const messages = await Promise.all(
    (data ?? []).map(async (msg) => ({
      ...msg,
      signedUrl: await signMediaUrl(supabase, msg.media_url),
    })),
  );

  return json({ messages });
}

async function uploadApprovedMessages(req: Request, supabase: any) {
  const form = await req.formData();
  const files = form.getAll("files").filter((value): value is File => value instanceof File);

  if (!files.length) return json({ error: "Choose at least one file." }, 400);
  if (files.length > MAX_ADMIN_MEDIA_COUNT) {
    return json({ error: `Upload up to ${MAX_ADMIN_MEDIA_COUNT} files at a time.` }, 400);
  }

  const results: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const baseResult = { filename: file.name, success: false };
    const validationError = validateAdminMedia(file);

    if (validationError) {
      results.push({ ...baseResult, error: validationError });
      continue;
    }

    const mediaType = adminMediaType(file);
    const storagePath = storagePathFor(file);
    const { error: uploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, file, {
        contentType: file.type || (mediaType === "video" ? "video/mp4" : "application/octet-stream"),
        upsert: false,
      });

    if (uploadError) {
      console.error("Admin media upload error:", uploadError);
      results.push({ ...baseResult, error: uploadError.message || "Upload failed." });
      continue;
    }

    const { data, error: insertError } = await supabase
      .from("messages")
      .insert({
        name: "Admin",
        body: "",
        media_url: storagePath,
        media_type: mediaType,
        status: "approved",
      })
      .select("id, name, body, media_url, media_type, status, created_at")
      .single();

    if (insertError) {
      console.error("Admin message insert error:", insertError);
      await supabase.storage.from(MEDIA_BUCKET).remove([storagePath]);
      results.push({ ...baseResult, error: "Uploaded file could not be saved." });
      continue;
    }

    results.push({
      ...baseResult,
      success: true,
      message: {
        ...data,
        signedUrl: await signMediaUrl(supabase, data.media_url),
      },
    });
  }

  const successCount = results.filter((result) => result.success).length;
  return json({ success: successCount > 0, results }, successCount > 0 ? 200 : 400);
}

async function updateMessageStatus(input: Record<string, unknown>, supabase: any) {
  const { id, action } = input;
  const isApprove = action === "approve";
  const isDisapprove = action === "disapprove" || action === "deny";

  if (typeof id !== "string" || (!isApprove && !isDisapprove)) {
    return json({ error: "Expected an id and action of approve or disapprove" }, 400);
  }

  if (isApprove) {
    const { data, error } = await supabase
      .from("messages")
      .update({ status: "approved" })
      .eq("id", id)
      .select("id, status")
      .single();

    if (error) {
      console.error("Admin update error:", error);
      return json({ error: "Could not update message" }, 500);
    }

    return json({ success: true, status: data.status });
  }

  let lastError = null;

  for (const status of DISAPPROVED_STATUSES) {
    const { data, error } = await supabase
      .from("messages")
      .update({ status })
      .eq("id", id)
      .select("id, status")
      .single();

    if (!error) return json({ success: true, status: data.status });
    lastError = error;
  }

  console.error("Admin disapprove update error:", lastError);
  return json({ error: "Could not disapprove message. Check the messages.status database constraint." }, 500);
}

async function updateMessageText(input: Record<string, unknown>, supabase: any) {
  const { id, name, body } = input;
  const cleanName = cleanText(name, 100);
  const cleanBody = cleanText(body, 2000);

  if (!id || typeof id !== "string") {
    return json({ error: "Expected a message id" }, 400);
  }

  if (!cleanName) {
    return json({ error: "Name is required" }, 400);
  }

  const { data, error } = await supabase
    .from("messages")
    .update({
      name: cleanName,
      body: cleanBody,
    })
    .eq("id", id)
    .select("id, name, body")
    .single();

  if (error) {
    console.error("Admin text update error:", error);
    return json({ error: "Could not update message text" }, 500);
  }

  return json({ success: true, message: data });
}

async function deleteMessage(req: Request, supabase: any) {
  const { id } = await req.json().catch(() => ({ id: null }));

  if (!id || typeof id !== "string") {
    return json({ error: "Expected a message id" }, 400);
  }

  const { data: message, error: fetchError } = await supabase
    .from("messages")
    .select("id, media_url")
    .eq("id", id)
    .single();

  if (fetchError) {
    console.error("Admin delete fetch error:", fetchError);
    return json({ error: "Could not load message to delete" }, 500);
  }

  if (message?.media_url && isSafeStoragePath(message.media_url)) {
    const { error: storageError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .remove([message.media_url]);

    if (storageError) {
      console.error("Admin media delete error:", storageError);
      return json({ error: "Could not delete message media" }, 500);
    }
  }

  const { error: deleteError } = await supabase
    .from("messages")
    .delete()
    .eq("id", id);

  if (deleteError) {
    console.error("Admin message delete error:", deleteError);
    return json({ error: "Could not delete message" }, 500);
  }

  return json({ success: true });
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
      return await listMessages(supabase, url.searchParams.get("status") || "pending");
    }

    if (req.method === "POST") {
      return await uploadApprovedMessages(req, supabase);
    }

    if (req.method === "PATCH") {
      const body = await req.json();

      if (body.action === "save") {
        return await updateMessageText(body, supabase);
      }

      return await updateMessageStatus(body, supabase);
    }

    if (req.method === "DELETE") {
      return await deleteMessage(req, supabase);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("Admin function error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
