import { z } from "zod";

export const signupSchema = z.object({
    email: z
        .string()
        .email("Invalid email address")
        .max(255, "Email too long")
        .trim()
        .toLowerCase(),
    password: z
        .string()
        .min(8, "Password must be at least 8 characters")
        .max(128, "Password too long"),
    fullName: z
        .string()
        .min(2, "Name must be at least 2 characters")
        .max(100, "Name too long")
        .trim(),
    role: z.enum(["field_investigator", "manager"], {
        errorMap: () => ({ message: "Role must be 'field_investigator' or 'manager'" }),
    }),
});

export const signinSchema = z.object({
    email: z
        .string()
        .email("Invalid email address")
        .max(255)
        .trim()
        .toLowerCase(),
    password: z
        .string()
        .min(1, "Password is required")
        .max(128),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type SigninInput = z.infer<typeof signinSchema>;
