import { z } from "zod";

const DISTRICTS = [
    "Dome", "Adenta", "Accra North", "Dodowa", "Accra Central",
    "Accra East", "Agbogba", "Northeast", "Kwabenya", "Accra South", "Southeast",
] as const;

export const createTransactionSchema = z.object({
    accountNumber: z
        .string()
        .min(1, "Account number is required")
        .max(50, "Account number too long")
        .trim(),
    accountName: z
        .string()
        .min(1, "Account name is required")
        .max(200, "Account name too long")
        .trim(),
    district: z.enum(DISTRICTS, {
        errorMap: () => ({ message: "Invalid district" }),
    }),
    transactionType: z.enum(["charge", "payment"], {
        errorMap: () => ({ message: "Transaction type must be charge or payment" }),
    }),
    amount: z
        .number()
        .positive("Amount must be positive")
        .max(1000000000, "Amount too large"),
    description: z
        .string()
        .max(1000, "Description too long")
        .trim()
        .optional()
        .nullable(),
    referenceReportId: z
        .string()
        .uuid("Invalid report ID format")
        .optional()
        .nullable(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
