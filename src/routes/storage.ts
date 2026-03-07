import { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase";
import { createClient } from "@supabase/supabase-js";
import { authenticate } from "../middleware/auth";

const BUCKET = "investigation-photos";
// Signed URLs expire after 24 hours (86400 seconds)
const SIGNED_URL_EXPIRY = 86400;

export async function storageRoutes(app: FastifyInstance) {
    /**
     * POST /api/storage/upload
     * Upload a photo to Supabase Storage.
     * Accepts base64-encoded image data.
     * Returns the file path (for DB storage) and a signed URL (for immediate display).
     */
    app.post(
        "/api/storage/upload",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const { base64, fileName, contentType } = request.body as {
                base64: string;
                fileName: string;
                contentType: string;
            };

            if (!base64 || !fileName || !contentType) {
                return reply.code(400).send({ error: "Missing base64, fileName, or contentType" });
            }

            // Validate content type
            const allowedTypes = ["image/jpeg", "image/png", "image/heic", "image/webp"];
            if (!allowedTypes.includes(contentType)) {
                return reply.code(400).send({ error: `Unsupported file type: ${contentType}. Allowed: ${allowedTypes.join(", ")}` });
            }

            // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
            const cleanBase64 = base64.includes(",") ? base64.split(",")[1] : base64;

            // Convert to Buffer
            const buffer = Buffer.from(cleanBase64, "base64");

            // Max 10MB
            if (buffer.length > 10 * 1024 * 1024) {
                return reply.code(400).send({ error: "File too large. Maximum size is 10MB." });
            }

            // Build unique file path: userId/timestamp-filename
            const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
            const filePath = `${user.id}/${Date.now()}-${sanitizedName}`;

            // Upload to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from(BUCKET)
                .upload(filePath, buffer, {
                    contentType,
                    upsert: false,
                });

            if (uploadError) {
                console.error("Storage upload error:", uploadError);
                return reply.code(500).send({ error: "Failed to upload file" });
            }

            // Generate a signed URL for immediate access
            const { data: signedData, error: signError } = await supabase.storage
                .from(BUCKET)
                .createSignedUrl(filePath, SIGNED_URL_EXPIRY);

            if (signError) {
                console.error("Signed URL error:", signError);
                return reply.code(500).send({ error: "File uploaded but failed to generate URL" });
            }

            return reply.code(201).send({
                filePath,
                signedUrl: signedData.signedUrl,
            });
        }
    );

    /**
     * DELETE /api/storage/delete
     * Remove a photo from Supabase Storage.
     */
    app.delete(
        "/api/storage/delete",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const { filePath } = request.body as { filePath: string };

            if (!filePath) {
                return reply.code(400).send({ error: "Missing filePath" });
            }

            // Security: field investigators can only delete their own files
            if (user.role === "field_investigator" && !filePath.startsWith(`${user.id}/`)) {
                return reply.code(403).send({ error: "You can only delete your own files" });
            }

            const { error } = await supabase.storage
                .from(BUCKET)
                .remove([filePath]);

            if (error) {
                console.error("Storage delete error:", error);
                return reply.code(500).send({ error: "Failed to delete file" });
            }

            return reply.send({ message: "File deleted successfully" });
        }
    );

    /**
     * POST /api/storage/signed-url
     * Generate a fresh signed URL for an existing file.
     * Used when displaying photos in the UI (since signed URLs expire).
     */
    app.post(
        "/api/storage/signed-url",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const { filePath } = request.body as { filePath: string };

            if (!filePath) {
                return reply.code(400).send({ error: "Missing filePath" });
            }


            try {
                // Create a fresh Supabase client to avoid stale singleton state
                // that causes "Object not found" errors on subsequent requests
                const freshClient = createClient(
                    process.env.SUPABASE_URL!,
                    process.env.SUPABASE_SERVICE_ROLE_KEY!,
                    { auth: { autoRefreshToken: false, persistSession: false } }
                );

                const { data, error } = await freshClient.storage
                    .from(BUCKET)
                    .createSignedUrl(filePath, SIGNED_URL_EXPIRY);

                if (error) {
                    console.error(`[STORAGE ERROR] createSignedUrl failed for "${filePath}":`, JSON.stringify(error, null, 2));
                    return reply.send({ signedUrl: null });
                }

                return reply.send({ signedUrl: data.signedUrl });
            } catch (err: any) {
                console.error(`[STORAGE EXCEPTION] Unexpected error for "${filePath}":`, err.message);
                return reply.send({ signedUrl: null });
            }
        }
    );
}
