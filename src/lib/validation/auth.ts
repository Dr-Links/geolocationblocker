import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email").max(254);

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be at most 128 characters")
  .regex(/[a-zA-Z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

export const signUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: emailSchema,
  password: passwordSchema,
  workspaceName: z.string().trim().min(2, "Workspace name is required").max(80),
});

export const signInSchema = z.object({
  email: emailSchema,
  // Don't leak policy on sign-in; just bound the input.
  password: z.string().min(1, "Password is required").max(128),
});

export type SignUpInput = z.infer<typeof signUpSchema>;
export type SignInInput = z.infer<typeof signInSchema>;

/** Signing up through an invite: the workspace already exists. */
export const signUpWithInviteSchema = signUpSchema.omit({ workspaceName: true });
