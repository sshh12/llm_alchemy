// Share card: a 1080×1350 PNG drawn client-side (art or placeholder, name, recipe, Origin
// badge, date, site), shared via the Web Share API when files are supported, otherwise
// downloaded with the link copied to the clipboard.
import type { ElementDTO } from "../../shared/api.ts";
import { track } from "./analytics.ts";
import { SITE_HOST, SITE_URL } from "../content.ts";
import { thumbUrl } from "./api.ts";
import { formatDay } from "./format.ts";
import { BLOB_PATHS, FALLBACK_EMOJI, placeholderFor } from "./placeholder.ts";

const W = 1080;
const H = 1350;
const INK = "#2A2118";
const MUTED = "#6B5D4E";

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight: number, family: string): number {
  let s = size;
  for (; s > 36; s -= 4) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return s;
}

export interface ShareInput {
  element: ElementDTO;
  recipe?: string;
  first?: boolean;
  /** ISO timestamp of the discovery (for the badge). */
  at?: string;
}

async function renderShareCard({ element, recipe, first, at }: ShareInput): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const display = '"Fraunces Variable", Georgia, serif';
  const sans = '"Instrument Sans Variable", system-ui, sans-serif';
  await Promise.allSettled([document.fonts.load(`600 96px ${display}`), document.fonts.load(`600 40px ${sans}`)]);

  // Paper + dot grid
  ctx.fillStyle = "#F6F1E7";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#E2D8C6";
  for (let y = 18; y < H; y += 36) for (let x = 18; x < W; x += 36) ctx.fillRect(x - 1.5, y - 1.5, 3, 3);

  // Wordmark
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.font = `600 44px ${display}`;
  ctx.fillText("Infinite Alchemy", W / 2, 120);

  // Ceramic tile
  const tile = 560;
  const tx = (W - tile) / 2;
  const ty = 200;
  ctx.save();
  ctx.shadowColor = "rgba(42,33,24,0.28)";
  ctx.shadowBlur = 60;
  ctx.shadowOffsetY = 26;
  roundRect(ctx, tx, ty, tile, tile, 150);
  ctx.fillStyle = "#FFFCF6";
  ctx.fill();
  ctx.restore();
  roundRect(ctx, tx, ty, tile, tile, 150);
  if (first) {
    const g = ctx.createLinearGradient(tx, ty, tx + tile, ty + tile);
    g.addColorStop(0, "#F3D47A");
    g.addColorStop(0.45, "#E9C25A");
    g.addColorStop(0.8, "#A8781C");
    ctx.strokeStyle = g;
    ctx.lineWidth = 10;
  } else {
    ctx.strokeStyle = "#DDD1BE";
    ctx.lineWidth = 3;
  }
  ctx.stroke();

  const art = element.img ? ((await loadImage(thumbUrl(element.img, 384))) ?? (await loadImage(element.img))) : null;
  const box = 400;
  const bx = (W - box) / 2;
  const by = ty + (tile - box) / 2;
  if (art) {
    ctx.drawImage(art, bx, by, box, box);
  } else {
    // Procedural placeholder (same blob + hues as the in-game tile, light theme).
    const p = placeholderFor(element.name);
    ctx.save();
    ctx.translate(bx, by);
    ctx.scale(box / 100, box / 100);
    ctx.translate(50, 50);
    ctx.rotate((p.rotate * Math.PI) / 180);
    ctx.translate(-50, -50);
    const grad = ctx.createRadialGradient(38, 32, 2, 50, 50, 72);
    grad.addColorStop(0, `hsl(${p.hue} 70% 86%)`);
    grad.addColorStop(1, `hsl(${p.hue2} 55% 70%)`);
    ctx.fillStyle = grad;
    ctx.fill(new Path2D(BLOB_PATHS[p.shape]));
    ctx.restore();
    ctx.font = `200px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(element.emoji || FALLBACK_EMOJI, W / 2, by + box / 2 + 10);
    ctx.textBaseline = "alphabetic";
  }

  // Name + recipe
  ctx.fillStyle = INK;
  const size = fitText(ctx, element.name, W - 140, 104, 600, display);
  ctx.font = `600 ${size}px ${display}`;
  ctx.fillText(element.name, W / 2, 900);
  if (recipe) {
    ctx.fillStyle = MUTED;
    const rs = fitText(ctx, recipe, W - 160, 42, 600, sans);
    ctx.font = `600 ${rs}px ${sans}`;
    ctx.fillText(recipe, W / 2, 970);
  }

  // Origin badge
  if (first) {
    const label = `First discovered by me · ${formatDay(at ?? new Date().toISOString())}`;
    ctx.font = `700 36px ${sans}`;
    const bw = ctx.measureText(label).width + 80;
    const bx2 = (W - bw) / 2;
    const g = ctx.createLinearGradient(bx2, 0, bx2 + bw, 0);
    g.addColorStop(0, "#F3D47A");
    g.addColorStop(0.5, "#FFF1C2");
    g.addColorStop(1, "#C9962E");
    roundRect(ctx, bx2, 1030, bw, 76, 38);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = "#4A3204";
    ctx.fillText(label, W / 2, 1081);
  }

  ctx.fillStyle = MUTED;
  ctx.font = `600 34px ${sans}`;
  ctx.fillText(`Make anything at ${SITE_HOST}`, W / 2, 1260);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

export type ShareOutcome = "shared" | "downloaded" | "cancelled" | "failed";

/** Where the share started: an element's details, or the world-first celebration card. */
export type ShareSurface = "details" | "celebration";

export async function shareElement(input: ShareInput, surface: ShareSurface): Promise<ShareOutcome> {
  const outcome = await shareCard(input);
  track("share", { outcome, first: !!input.first, surface });
  return outcome;
}

async function shareCard(input: ShareInput): Promise<ShareOutcome> {
  const { element, first } = input;
  const text = first ? `I was the first person ever to discover ${element.name} in Infinite Alchemy!` : `I made ${element.name} in Infinite Alchemy.`;
  try {
    const blob = await renderShareCard(input);
    if (!blob) return "failed";
    const file = new File([blob], `${element.name.replace(/[^\w-]+/g, "-").toLowerCase()}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: element.name, text, url: SITE_URL });
        return "shared";
      } catch (e) {
        if ((e as DOMException).name === "AbortError") return "cancelled";
      }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4_000);
    await navigator.clipboard?.writeText(`${text} ${SITE_URL}`).catch(() => {});
    return "downloaded";
  } catch {
    return "failed";
  }
}
