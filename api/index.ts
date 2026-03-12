import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";
import { authRoutes } from "../src/routes/auth";
import { reportRoutes } from "../src/routes/reports";
import { storageRoutes } from "../src/routes/storage";

// Build the Fastify app
export function buildApp() {
    const app = Fastify({
        logger: true,
        bodyLimit: 6 * 1024 * 1024, // 6MB max body (for base64 photo uploads)
    });

    // Compression — reduces bandwidth usage (Vercel egress)
    app.register(compress, { global: true });

    // Security headers
    app.register(helmet, {
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", "data:", "https://*.supabase.co", "https://res.cloudinary.com"],
                connectSrc: ["'self'", "https://*.supabase.co", "https://api.cloudinary.com", "https://res.cloudinary.com"],
            },
        },
    });

    // CORS — restrict to frontend origin
    const allowedOrigins = [
        process.env.FRONTEND_URL,
        "https://field-investigation-tracker.vercel.app",
        // Local connections should use the FRONTEND_URL env var
    ].filter(Boolean) as string[];

    app.register(cors, {
        origin: (origin, cb) => {
            // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
            if (!origin) return cb(null, true);
            if (allowedOrigins.some((allowed) => origin.startsWith(allowed))) {
                return cb(null, true);
            }
            return cb(new Error("Not allowed by CORS"), false);
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-signup-secret"],
    });

    // Health check
    app.get("/api/health", async () => {
        return { status: "ok", timestamp: new Date().toISOString() };
    });

    // Register routes
    app.register(authRoutes);
    app.register(reportRoutes);
    app.register(storageRoutes);

    app.setErrorHandler((error: any, request, reply) => {
        app.log.error(error);
        const statusCode = error.statusCode || 500;

        // Sanitize error message for production: hide internal details on 500s
        const message = statusCode >= 500
            ? "An unexpected internal server error occurred"
            : error.message;

        reply.code(statusCode).send({
            error: message,
            ...(process.env.NODE_ENV === "development" ? { stack: error.stack } : {})
        });
    });

    return app;
}

// Vercel serverless handler
const app = buildApp();

export default async function handler(req: any, res: any) {
    await app.ready();
    app.server.emit("request", req, res);
}
