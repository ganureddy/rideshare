// Image picker + Frappe upload_file helper.
//
// Frappe exposes /api/method/upload_file which accepts multipart/form-data
// with a `file` part and a few flags.  Authenticated requests using the
// Authorization: token <key>:<secret> header bypass CSRF, so we can post
// directly from the device without a `/api/method/login` round-trip.
//
// We wrap expo-image-picker to keep call sites tiny — `pickAndUploadImage`
// returns the public file URL ready to drop into a payload.

import * as ImagePicker from "expo-image-picker";
import { ENV } from "@/env";
import { credentialsStore } from "@/auth/store";
import { alert } from "@/components/AlertHost";
export type UploadedFile = {
  /** Path on the Frappe server, e.g. "/files/photo.png".  Prepend ENV.apiBaseUrl to make absolute. */
  fileUrl: string;
  /** Frappe's File doctype name. */
  fileName: string;
  /** Best-effort byte size returned by the server. */
  size?: number | null;
};

export type PickAndUploadOpts = {
  /** Allow square cropping. */
  allowsEditing?: boolean;
  /** Default 0.7 — Expo recommends 0.5–0.8 to keep payloads small. */
  quality?: number;
  /** Source of the image. Defaults to "library". */
  source?: "library" | "camera";
  /** When true the file is uploaded as private (only the owner + admins can read).
      Profile / car photos are public so other riders can see them. */
  isPrivate?: boolean;
  /** Optional: attach the resulting File to a doctype/docname/fieldname. */
  attachTo?: { doctype: string; docname: string; fieldname?: string };
};

/**
 * Show the picker, upload the chosen image to Frappe, return the file URL.
 * Returns null when the user cancels — never throws on cancellation.
 */
export async function pickAndUploadImage(
  opts: PickAndUploadOpts = {}
): Promise<UploadedFile | null> {
  const granted = await ensureMediaPermission(opts.source ?? "library");
  if (!granted) {
    alert(
      "Permission needed",
      opts.source === "camera"
        ? "Allow camera access to capture a photo."
        : "Allow access to your photos to attach an image."
    );
    return null;
  }

  const launcher =
    opts.source === "camera"
      ? ImagePicker.launchCameraAsync
      : ImagePicker.launchImageLibraryAsync;

  const res = await launcher({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: opts.allowsEditing ?? false,
    quality: opts.quality ?? 0.7,
    exif: false
  });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  return uploadAsset(asset, { isPrivate: opts.isPrivate, attachTo: opts.attachTo });
}

/** Multi-image picker (gallery only) — handy for car photo galleries. */
export async function pickAndUploadImages(
  max: number = 5,
  opts: Omit<PickAndUploadOpts, "source"> = {}
): Promise<UploadedFile[]> {
  const granted = await ensureMediaPermission("library");
  if (!granted) {
    alert(
      "Permission needed",
      "Allow access to your photos to attach images."
    );
    return [];
  }

  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsMultipleSelection: true,
    selectionLimit: Math.max(1, Math.min(10, max)),
    quality: opts.quality ?? 0.7,
    exif: false
  });
  if (res.canceled || !res.assets?.length) return [];

  const out: UploadedFile[] = [];
  for (const a of res.assets.slice(0, max)) {
    try {
      const f = await uploadAsset(a, { isPrivate: opts.isPrivate, attachTo: opts.attachTo });
      if (f) out.push(f);
    } catch (e: any) {
      alert("Upload failed", e?.message ?? "Try a different photo.");
    }
  }
  return out;
}

async function ensureMediaPermission(
  source: "library" | "camera"
): Promise<boolean> {
  try {
    if (source === "camera") {
      const existing = await ImagePicker.getCameraPermissionsAsync();
      if (existing.granted) return true;
      const next = await ImagePicker.requestCameraPermissionsAsync();
      return next.status === "granted";
    } else {
      const existing = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (existing.granted) return true;
      const next = await ImagePicker.requestMediaLibraryPermissionsAsync();
      return next.status === "granted";
    }
  } catch {
    return false;
  }
}

async function uploadAsset(
  asset: ImagePicker.ImagePickerAsset,
  opts: { isPrivate?: boolean; attachTo?: PickAndUploadOpts["attachTo"] }
): Promise<UploadedFile> {
  const creds = await credentialsStore.get();
  if (!creds) throw new Error("Not signed in.");

  const form = new FormData();
  // React Native special: pass an object with uri/name/type to FormData.
  const inferredName =
    asset.fileName ||
    asset.uri.split("/").pop() ||
    `upload-${Date.now()}.jpg`;
  const inferredType = asset.mimeType || guessTypeFromName(inferredName) || "image/jpeg";
  form.append("file", {
    // The cast is required by RN's FormData typings — the runtime accepts
    // an object with these three keys natively.
    uri: asset.uri,
    name: inferredName,
    type: inferredType
  } as any);
  form.append("is_private", opts.isPrivate ? "1" : "0");
  form.append("folder", "Home/Attachments");
  if (opts.attachTo) {
    form.append("doctype", opts.attachTo.doctype);
    form.append("docname", opts.attachTo.docname);
    if (opts.attachTo.fieldname) form.append("fieldname", opts.attachTo.fieldname);
  }

  const url = `${ENV.apiBaseUrl.replace(/\/$/, "")}/api/method/upload_file`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `token ${creds.apiKey}:${creds.apiSecret}`,
      Accept: "application/json"
      // No Content-Type — fetch sets the multipart boundary itself.
    },
    body: form as any
  });

  if (!resp.ok) {
    let serverMsg: string | undefined;
    try {
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        if (data?._server_messages) {
          const arr = JSON.parse(data._server_messages);
          serverMsg = JSON.parse(arr[0]).message;
        } else {
          serverMsg = data?.message ?? data?.exception ?? text.slice(0, 200);
        }
      } catch {
        serverMsg = text.slice(0, 200);
      }
    } catch {/* ignore */}
    throw new Error(serverMsg || `Upload failed (HTTP ${resp.status}).`);
  }

  const json = await resp.json();
  const msg = json?.message ?? {};
  return {
    fileUrl: msg.file_url || msg.fileUrl || msg.file_name || "",
    fileName: msg.name || msg.file_name || inferredName,
    size: msg.file_size ?? null
  };
}

function guessTypeFromName(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop();
  if (!ext) return null;
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "heic") return "image/heic";
  return null;
}

/**
 * Resolve a file URL we got back from the server (often a relative
 * "/files/..." path) into something <Image source={{uri}} /> can load.
 * Returns null when the input is empty.
 */
export function absoluteFileUrl(fileUrl?: string | null): string | null {
  if (!fileUrl) return null;
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return `${ENV.apiBaseUrl.replace(/\/$/, "")}${fileUrl.startsWith("/") ? "" : "/"}${fileUrl}`;
}
