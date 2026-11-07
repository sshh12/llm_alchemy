// Element art in Netlify Blobs. Each generation gets a fresh random key, so the public
// URL `/img/<id>/<key>.<ext>` is immutable and can be cached forever by browsers and the CDN.
import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";

export type ArtExt = "webp" | "png";

export const ART_CONTENT_TYPES: Record<ArtExt, string> = {
  webp: "image/webp",
  png: "image/png",
};

function store() {
  return getStore({ name: "element-art", consistency: "strong" });
}

/** A new image file name (stored in elements.image_key), e.g. "3f9a0c1d2e4b6a7c.webp". */
export function newImageKey(ext: ArtExt): string {
  return `${randomBytes(8).toString("hex")}.${ext}`;
}

/** Public path served by netlify/functions/img.mts. */
export function imgPath(elementId: string, imageKey: string): string {
  return `/img/${elementId}/${imageKey}`;
}

const blobKey = (elementId: string, imageKey: string) => `el/${elementId}/${imageKey}`;

export async function putArt(elementId: string, imageKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
  // Copy into a standalone ArrayBuffer (Blobs accepts ArrayBuffer, not a Uint8Array view).
  const data = bytes.slice().buffer as ArrayBuffer;
  await store().set(blobKey(elementId, imageKey), data, { metadata: { contentType } });
}

export async function getArt(elementId: string, imageKey: string): Promise<ArrayBuffer | null> {
  return store().get(blobKey(elementId, imageKey), { type: "arrayBuffer" });
}
