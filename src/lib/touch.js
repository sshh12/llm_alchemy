export const isTouchCapable =
  "ontouchstart" in window ||
  (window.DocumentTouch && document instanceof window.DocumentTouch) ||
  navigator.maxTouchPoints > 0 ||
  window.navigator.msMaxTouchPoints > 0;
