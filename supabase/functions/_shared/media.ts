export const MEDIA_BUCKET = "memorial-media";

export const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export const VIDEO_TYPES = new Map([
  ["video/mp4", "mp4"],
]);

export const MESSAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
]);

export const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
export const MESSAGE_MEDIA_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "mp4"]);
export const MAX_ADMIN_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_ADMIN_VIDEO_SIZE = 100 * 1024 * 1024;
export const MAX_ADMIN_MEDIA_COUNT = 25;

export function mediaExtension(path = "") {
  return path.split("?")[0].split(".").pop()?.toLowerCase() || "";
}

export function isSafeStoragePath(path: unknown) {
  if (typeof path !== "string") return false;
  if (!path || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("..") || path.includes("\\")) return false;
  return /^(media|admin-media)\/[a-zA-Z0-9][a-zA-Z0-9/_\-.]*$/.test(path);
}

export function sanitizeFilename(name = "image") {
  return name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "image";
}

export function adminMediaType(file: File) {
  const extension = mediaExtension(file.name);
  if (VIDEO_TYPES.has(file.type) || extension === "mp4") return "video";
  return "image";
}

export function mediaContentExtension(file: File) {
  return IMAGE_TYPES.get(file.type) || VIDEO_TYPES.get(file.type) || mediaExtension(file.name) || "bin";
}

export function validateAdminMedia(file: File) {
  const extension = mediaExtension(file.name);

  if (!MESSAGE_MEDIA_TYPES.has(file.type) && !MESSAGE_MEDIA_EXTENSIONS.has(extension)) {
    return "Only MP4, JPEG, PNG, and WebP files are supported.";
  }

  if (file.size <= 0) return "File is empty.";
  if (adminMediaType(file) === "video") {
    if (file.size > MAX_ADMIN_VIDEO_SIZE) return "Videos must be 100 MB or smaller.";
  } else if (file.size > MAX_ADMIN_IMAGE_SIZE) {
    return "Images must be 10 MB or smaller.";
  }

  return null;
}

export async function signMediaUrl(supabase: any, path: string | null, expiresIn = 3600) {
  if (!path || !isSafeStoragePath(path)) return null;

  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(path, expiresIn);

  if (error) {
    console.error("Signed URL error:", error);
    return null;
  }

  return data?.signedUrl || null;
}
