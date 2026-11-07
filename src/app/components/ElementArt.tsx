// Element art: the procedural placeholder (name-hashed gradient blob + emoji) renders
// instantly; AI art is requested only while this tile is actually visible, then fades in
// over the placeholder. Thumbnails come from the Netlify Image CDN, falling back to the
// raw image path (and finally the placeholder) if the CDN fails.
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import type { ElementDTO } from "../../shared/api.ts";
import { thumbUrl } from "../lib/api.ts";
import { setArtVisible } from "../lib/images.ts";
import { BLOB_PATHS, FALLBACK_EMOJI, placeholderFor } from "../lib/placeholder.ts";
import { observeVisibility } from "../lib/visibility.ts";

interface Props {
  element: Pick<ElementDTO, "id" | "name" | "emoji" | "img" | "art">;
  /** Rendered box size in px (sizes the emoji and picks the thumbnail width). */
  box: number;
  /** Request generation when visible (false for decorative copies, e.g. drag ghosts). */
  request?: boolean;
}

export const Placeholder = memo(function Placeholder({ name, emoji, hidden }: { name: string; emoji: string | null; hidden?: boolean }) {
  const p = placeholderFor(name);
  const gid = `ph${p.hue}-${p.hue2}`;
  return (
    <span className="ph" data-hidden={hidden ? "" : undefined} style={{ "--h1": p.hue, "--h2": p.hue2 } as CSSProperties}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <defs>
          <radialGradient id={gid} cx="38%" cy="32%" r="78%">
            <stop offset="0" className="ph-a" />
            <stop offset="1" className="ph-b" />
          </radialGradient>
        </defs>
        <path d={BLOB_PATHS[p.shape]} fill={`url(#${gid})`} transform={`rotate(${p.rotate} 50 50)`} />
      </svg>
      <span className="ph-emoji">{emoji || FALLBACK_EMOJI}</span>
    </span>
  );
});

export const ElementArt = memo(function ElementArt({ element, box, request = true }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [instant, setInstant] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const { id, img, art } = element;

  // Ask for art generation only while visible.
  useEffect(() => {
    const el = ref.current;
    if (!el || !request || art !== "missing") return;
    return observeVisibility(el, (v) => setArtVisible(id, v));
  }, [id, art, request]);

  useEffect(() => {
    setLoaded(false);
    setSrc(img ? thumbUrl(img, box > 120 ? 384 : 192) : null);
  }, [img, box]);

  // Cached images can complete before React attaches onLoad: show them without a fade.
  useEffect(() => {
    const el = imgRef.current;
    if (el?.complete && el.naturalWidth > 0) {
      setInstant(true);
      setLoaded(true);
    }
  }, [src]);

  return (
    <span ref={ref} className="art" style={{ "--box": `${box}px` } as CSSProperties}>
      <Placeholder name={element.name} emoji={element.emoji} hidden={loaded} />
      {src && (
        <img
          ref={imgRef}
          className="art-img"
          src={src}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          data-loaded={loaded ? "" : undefined}
          data-instant={instant ? "" : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => {
            // CDN miss (or local dev without the Image CDN): try the raw path once, then give up.
            if (img && src !== img) setSrc(img);
            else setSrc(null);
          }}
        />
      )}
    </span>
  );
});
