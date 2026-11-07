// One shared IntersectionObserver for every tile (library rows, canvas, sheets).
// Intersection accounts for clipping by scroll containers, so a tile in an overscanned
// virtual row that is scrolled out of view does not count as visible.
type Callback = (visible: boolean) => void;

const callbacks = new WeakMap<Element, Callback>();
let io: IntersectionObserver | null = null;

function observer(): IntersectionObserver {
  io ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
    },
    { threshold: 0.01 },
  );
  return io;
}

export function observeVisibility(el: Element, cb: Callback): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => cb(false);
  }
  let last = false;
  callbacks.set(el, (v) => {
    if (v === last) return;
    last = v;
    cb(v);
  });
  observer().observe(el);
  return () => {
    observer().unobserve(el);
    callbacks.delete(el);
    if (last) cb(false);
  };
}
