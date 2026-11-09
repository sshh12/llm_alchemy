// Coarse user-agent class for analytics (players.acq_ua_class). Only the class is stored, never
// the raw User-Agent: enough to exclude crawlers from player metrics and to split activation by
// platform (e.g. school Chromebooks), nothing that identifies a device.

export type UaClass = "bot" | "chromeos" | "android" | "ios" | "windows" | "mac" | "linux" | "other" | "unknown";

/**
 * Crawlers, previewers and headless browsers. Crawler names end in "bot" followed by "/", "-",
 * ";" or ")" (Googlebot/2.1, AdsBot-Google, GPTBot/1.0); a bare /bot/ would also match phone
 * models such as "CUBOT_X30", which are followed by "_" or a space.
 */
const BOT = /bot[-/;)]|crawler|spider|slurp|headlesschrome|lighthouse|inspectiontool|bingpreview|facebookexternalhit|embedly|yandex|petalsearch/i;

export function classifyUserAgent(ua: string | null | undefined): UaClass {
  if (!ua || !ua.trim()) return "unknown";
  if (BOT.test(ua)) return "bot";
  if (/\bCrOS\b/.test(ua)) return "chromeos";
  if (/Android/i.test(ua)) return "android";
  // iPadOS 13+ Safari reports itself as a Mac; it lands in "mac", which no server-side check can avoid.
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}
