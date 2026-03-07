import { z } from "zod";

const DISTRICTS = [
    "Dome", "Adenta", "Accra North", "Dodowa", "Accra Central",
    "Accra East", "Agbogba", "Northeast", "Kwabenya", "Accra South", "Southeast",
] as const;

const IRREGULARITY_TYPES = [
    "Meter By-Pass", "Meter Tampering", "Working Meter But On Estimate",
    "Suspected Low Estimate", "Unauthorized Use Of Service",
    "Interference After Disconnection", "Damage To GWL Installation",
    "Use Of In-Line Booster On Our Service Line",
    "Illegal Connection To Our Network", "Other",
] as const;

const SERVICE_CATEGORIES = [
    "Residential", "Commercial", "Industrial",
    "Government/Institutional", "Mixed Use",
] as const;

export const createReportSchema = z.object({
    region: z
        .string()
        .min(1, "Region is required")
        .max(100)
        .trim(),
    district: z.enum(DISTRICTS, {
        errorMap: () => ({ message: "Invalid district" }),
    }),
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
    irregularities: z
        .array(z.enum(IRREGULARITY_TYPES))
        .min(1, "At least one irregularity must be selected"),
    otherIrregularityDetails: z
        .string()
        .max(1000, "Details too long")
        .trim()
        .optional()
        .nullable(),
    ongoingActivity: z
        .string()
        .max(2000, "Activity description too long")
        .trim()
        .optional()
        .default(""),
    existingServiceCategory: z.enum(SERVICE_CATEGORIES, {
        errorMap: () => ({ message: "Invalid service category" }),
    }),
    actionTaken: z
        .string()
        .min(1, "Action taken is required")
        .max(2000, "Action description too long")
        .trim(),
    meterReplacedOrNew: z.boolean(),
    photoUrl: z
        .string()
        .max(2048)
        .optional()
        .nullable(),
    latitude: z
        .number()
        .min(-90)
        .max(90),
    longitude: z
        .number()
        .min(-180)
        .max(180),
});

export type CreateReportInput = z.infer<typeof createReportSchema>;
