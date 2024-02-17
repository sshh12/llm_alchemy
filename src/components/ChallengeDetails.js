import { HStack, Button, Spacer, Text, VStack } from "@chakra-ui/react";
import Swal from "sweetalert2";
import withReactContent from "sweetalert2-react-content";

const swal = withReactContent(Swal);

const CHALLENGE_INFO =
  "These are daily elements you can make to earn free mixtures (easy 5 / hard 50 / expert 500). All challenges can be done by only combining 2 elements at a time and with already discovered combinations (meaning you can solve them without using any mixtures).";

export default function ChallengeDetails({ stats }) {
  let completedCount = 0;
  if (stats?.dailyChallengeHistory) {
    completedCount = stats.dailyChallengeHistory.reduce(
      (acc, v) => acc + (v.completedEasy + v.completedHard + v.completedExpert),
      0
    );
  }

  const showChallengeInfo = () => {
    if (!stats) {
      return;
    }
    const history = stats.dailyChallengeHistory;
    history.sort((a, b) => (a.date < b.date ? 1 : -1));
    const formatCell = (name, completed) => {
      const color = completed ? "#60b487" : "#c53030";
      return `<td style="color:${color};font-size:0.9rem">${name}</td>`;
    };
    const listHTML =
      "<br/><br/><table style='text-align: center; width: 100%; white-space: normal'>" +
      history
        .filter(
          (dc) => dc.completedEasy || dc.completedHard || dc.completedExpert
        )
        .map((dc) => {
          return `<tr><td><b>${dc.date.slice(5)}</b></td>${formatCell(
            dc.elementEasy,
            dc.completedEasy
          )}${formatCell(dc.elementHard, dc.completedHard)}${formatCell(
            dc.elementExpert,
            dc.completedExpert
          )}</tr>`;
        })
        .join("") +
      "</table>";
    swal.fire({
      title: `Daily Challenges`,
      html: CHALLENGE_INFO + listHTML,
      customClass: "challenge-info-dialog",
    });
  };

  return (
    <VStack p={2}>
      <HStack align="center" justifyContent={"space-around"}>
        <Text color="green.700">
          <b>{stats?.dailyChallenge.elementEasy}</b>
        </Text>
        <Spacer />
        <Text color="orange.600">
          <b>{stats?.dailyChallenge.elementHard}</b>
        </Text>
        <Spacer />
        <Text color="red.700">
          <b>{stats?.dailyChallenge.elementExpert}</b>
        </Text>
        <Spacer />
      </HStack>
      <Button size="xs" colorScheme="blue" onClick={() => showChallengeInfo()}>
        Completed Challenges {completedCount}
      </Button>
    </VStack>
  );
}
