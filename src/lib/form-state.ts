/**
 * Shape returned by Server Actions to the forms that call them (React `useActionState`).
 *
 * Errors carry a stable CODE, never a sentence: the form translates it in the user's language
 * (see components/forms/error-text.tsx), and the server never has to know the UI language.
 */
export type FormState<T = undefined> =
  | { status: "idle" }
  | { status: "error"; error: string; params?: Record<string, string | number> }
  | { status: "success"; data?: T; params?: Record<string, string | number> };

export const idle: FormState<never> = { status: "idle" };

export const errorState = (error: string, params?: Record<string, string | number>): FormState<never> => ({
  status: "error",
  error,
  params,
});
