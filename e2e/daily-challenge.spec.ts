// (5) Daily challenge: make today's easy target from known recipes; the tier is marked
// complete with a celebration, and stays complete after a reload.
import { expect, test } from "./support/test.ts";

test("completing today's easy target marks it done and survives a reload", async ({ game, fx, snap }) => {
  const boot = await game.startFresh();
  expect(boot.challenge?.targets.map((t) => [t.tier, t.element.name])).toEqual([
    ["easy", fx.challenge.easy],
    ["hard", fx.challenge.hard],
    ["expert", fx.challenge.expert],
  ]);

  let sheet = await game.openChallenges();
  await expect(game.challengeTarget("easy")).toContainText(fx.challenge.easy);
  await expect(game.challengeTarget("easy")).toHaveAttribute("data-completed", "false");
  await snap("challenges-before");
  await game.closeSheet(sheet);

  const path = fx.challenge.easyPath;
  await game.makeAll(path.slice(0, -1));
  const last = path.at(-1)!;
  const res = await game.combineByTap(last.ingredients);
  expect(res.result.name).toBe(fx.challenge.easy);
  expect(res.completed).toEqual(["easy"]);

  await expect(game.challengeComplete).toBeVisible();
  await expect(game.challengeComplete).toHaveAttribute("data-tier", "easy");
  await expect(game.challengeComplete).toContainText(fx.challenge.easy);
  await snap("celebration");
  await game.dismissCelebrations(res);

  sheet = await game.openChallenges();
  await expect(game.challengeTarget("easy")).toHaveAttribute("data-completed", "true");
  await expect(game.challengeTarget("hard")).toHaveAttribute("data-completed", "false");
  await snap("challenges-after");
  await game.closeSheet(sheet);

  const again = await game.reload();
  expect(again.challenge?.targets.find((t) => t.tier === "easy")?.completed).toBe(true);
  expect(again.stats.challengesCompleted).toBe(1);
  await game.openChallenges();
  await expect(game.challengeTarget("easy")).toHaveAttribute("data-completed", "true");
  await snap("after-reload");
});
