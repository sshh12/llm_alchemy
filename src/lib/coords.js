export function boxesIntersect(a, b) {
  const halfWidthA = a.w / 2;
  const halfHeightA = a.h / 2;
  const halfWidthB = b.w / 2;
  const halfHeightB = b.h / 2;

  return (
    Math.abs(a.x - b.x) < halfWidthA + halfWidthB &&
    Math.abs(a.y - b.y) < halfHeightA + halfHeightB
  );
}

export function findIntersections(elements, targetId) {
  const target = elements.find((el) => el.id === targetId);
  return elements
    .filter((el) => el.id !== targetId && boxesIntersect(el, target))
    .map((el) => el.id);
}
