export const isTouchCapable =
  "ontouchstart" in window ||
  (window.DocumentTouch && document instanceof window.DocumentTouch) ||
  navigator.maxTouchPoints > 0 ||
  window.navigator.msMaxTouchPoints > 0;

export function disableScroll() {
  document.getElementsByTagName("html")[0].style.overflow = "hidden";
}

export function enableScroll() {
  document.getElementsByTagName("html")[0].style.overflow = null;
}
