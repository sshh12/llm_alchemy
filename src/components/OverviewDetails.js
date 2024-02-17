import {
  Stat,
  StatLabel,
  StatNumber,
  HStack,
  Button,
  StatHelpText,
} from "@chakra-ui/react";
import Swal from "sweetalert2";
import withReactContent from "sweetalert2-react-content";

const swal = withReactContent(Swal);

export default function OverviewDetails({
  starterElements,
  stats,
  userId,
  credits,
}) {
  const showUserInfo = () => {
    swal.fire({
      title: `Your Stats`,
      text: `Congrats! You are the first person to discover asdasd.`,
      html: `You invented <b>${stats.userCreatedElements.length}</b> elements ${
        stats.userCreatedElements.length > 0
          ? "<br/>" + stats.userCreatedElements.join(", ")
          : ""
      }<hr style="margin:10px"/>User ID: <b>${userId}</b>`,
    });
  };

  return (
    <HStack padding={"20px"}>
      <Stat>
        <StatLabel>
          Your
          <br />
          Elements
        </StatLabel>
        <StatNumber>{starterElements.length}</StatNumber>
        <StatHelpText>
          {stats &&
            Math.ceil((starterElements.length / stats?.totalElements) * 100)}
          %
        </StatHelpText>
      </Stat>
      <Stat>
        <StatLabel>
          Known <br />
          Elements
        </StatLabel>
        <StatNumber>{stats?.totalElements || "25000"}</StatNumber>
        <StatHelpText>
          {stats && (
            <Button size="xs" colorScheme="blue" onClick={() => showUserInfo()}>
              You Invented {stats?.userCreatedElements.length}
            </Button>
          )}
        </StatHelpText>
      </Stat>
      <Stat>
        <StatLabel>
          Mixtures <br />
          Remaining
        </StatLabel>
        <StatNumber>{credits || 0}</StatNumber>
        <StatHelpText>
          {stats && userId && (
            <Button size="xs" colorScheme="green">
              <a
                href={`https://buy.stripe.com/6oE7w1cNbbC07IIeUV?client_reference_id=infalchemy___${userId.replace(
                  ":",
                  "_"
                )}`}
              >
                Buy More
              </a>
            </Button>
          )}
        </StatHelpText>
      </Stat>
    </HStack>
  );
}
