import { FastifyInstance } from "fastify";
import cloudinary from "../lib/cloudinary";
import { authenticate } from "../middleware/auth";

export async function storageRoutes(app: FastifyInstance) {
    /**
     * POST /api/storage/upload
     * Upload a photo to Cloudinary.
     * Accepts base64-encoded image data.
     * Returns the public_id (as filePath) and the secure_url.
     */
    app.post(
        "/api/storage/upload",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const { base64, contentType } = request.body as {
                base64: string;
                fileName: string;
                contentType: string;
            };

            if (!base64 || !contentType) {
                return reply.code(400).send({ error: "Missing base64 or contentType" });
            }

            // Validate content type
            const allowedTypes = ["image/jpeg", "image/png", "image/heic", "image/webp"];
            if (!allowedTypes.includes(contentType)) {
                return reply.code(400).send({ error: `Unsupported file type: ${contentType}` });
            }

            try {
                // Upload to Cloudinary
                // We pass the base64 string directly (with data URI prefix if present)
                const uploadResult = await cloudinary.uploader.upload(base64, {
                    folder: `field_investigations/${user.id}`,
                    resource_type: "image",
                    // Optional: auto-optimization on upload
                    quality: "auto",
                    fetch_format: "auto"
                });

                return reply.code(201).send({
                    filePath: uploadResult.public_id, // We store public_id in the DB
                    signedUrl: uploadResult.secure_url, // For immediate display
                });
            } catch (error) {
                console.error("Cloudinary upload error:", error);
                return reply.code(500).send({ error: "Failed to upload to Cloudinary" });
            }
        }
    );

    /**
     * DELETE /api/storage/delete
     * Remove a photo from Cloudinary.
     */
    app.delete(
        "/api/storage/delete",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const { filePath: publicId } = request.body as { filePath: string };

            if (!publicId) {
                return reply.code(400).send({ error: "Missing publicId" });
            }

            // Security: field investigators can only delete their own files
            // (Assuming folder structure field_investigations/{user.id}/...)
            if (user.role === "field_investigator" && !publicId.startsWith(`field_investigations/${user.id}/`)) {
                return reply.code(403).send({ error: "You can only delete your own files" });
            }

            try {
                const result = await cloudinary.uploader.destroy(publicId);
                if (result.result !== "ok") {
                    console.error("Cloudinary delete result not ok:", result);
                    // Return 200 anyway if it was already deleted or not found
                }
                return reply.send({ message: "File deleted successfully" });
            } catch (error) {
                console.error("Cloudinary delete error:", error);
                return reply.code(500).send({ error: "Failed to delete from Cloudinary" });
            }
        }
    );

    /**
     * POST /api/storage/signed-url
     * Get the URL for a Cloudinary public_id.
     * With Cloudinary, we can return the direct URL or a transformed version.
     */
    app.post(
        "/api/storage/signed-url",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const { filePath: publicId } = request.body as { filePath: string };

            if (!publicId) {
                return reply.code(400).send({ error: "Missing publicId" });
            }

            // If it's a full URL already (legacy or external), just return it
            if (publicId.startsWith("http")) {
                return reply.send({ signedUrl: publicId });
            }

            try {
                // Generate a secure URL. Since Cloudinary URLs are permanent, 
                // we don't need a "signed" URL for standard public uploads.
                // We can also apply transformations here (e.g. sharpening for meter reading)
                const url = cloudinary.url(publicId, {
                    secure: true,
                    quality: "auto",
                    fetch_format: "auto",
                    // Example transformation: sharpen for better text legibility
                    effect: "sharpen:100"
                });

                return reply.send({ signedUrl: url });
            } catch (err: any) {
                console.error(`[CLOUDINARY ERROR] url generation failed for "${publicId}":`, err.message);
                return reply.send({ signedUrl: null });
            }
        }
    );
}
