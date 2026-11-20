import { buildTouchProbabilityMatrix } from "../scenarioMonteCarlo.js";

function serializeError(error) {
  if (!error) {
    return "Monte Carlo simulation failed.";
  }

  if (typeof error === "string") {
    return error;
  }

  return error?.message ?? "Monte Carlo simulation failed.";
}

self.onmessage = (event) => {
  const message = event?.data ?? null;

  if (!message || message.type !== "compute") {
    return;
  }

  const requestId = message.requestId ?? "";
  const payload = message.payload ?? null;

  try {
    const { prob_matrix, meta } = buildTouchProbabilityMatrix(payload ?? {});

    self.postMessage(
      {
        type: "result",
        requestId,
        probBuffer: prob_matrix.buffer,
        meta
      },
      [prob_matrix.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      error: serializeError(error)
    });
  }
};

