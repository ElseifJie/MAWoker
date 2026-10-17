import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 8;

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be a valid email address")
  .transform((value) => value.toLowerCase());

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(200);

export const credentialsSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(200),
  })
  .strict();

export type Credentials = z.infer<typeof credentialsSchema>;

export const createUserSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(["user", "admin"]).default("user"),
  })
  .strict();

export type CreateUserInput = z.infer<typeof createUserSchema>;

export const resetPasswordSchema = z
  .object({
    password: passwordSchema,
  })
  .strict();

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
