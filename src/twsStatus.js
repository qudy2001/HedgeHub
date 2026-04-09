export function isTwsReady(status) {
  return (
    status?.configured === true &&
    status?.connected === true &&
    status?.authenticated === true &&
    status?.ready === true &&
    status?.isPaper === true
  );
}

