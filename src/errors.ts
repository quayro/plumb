// caught values are unknown; these read them without trusting their shape
export const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error), { cause: error });

export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
