const { PrismaClient } = require("@prisma/client");
const readline = require("readline");

const prisma = new PrismaClient();

function prompt(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

(async () => {
  const userId = await prompt("UserId: ");
  const user = await prisma.alchemyCredits.findMany({
    where: { userId: userId },
  });
  console.log(user);
  const credits = parseInt(await prompt("credits: "));
  if (credits) {
    await prisma.alchemyCredits.update({
      where: { userId: userId },
      data: {
        credits: credits,
      },
    });
  }
})();
