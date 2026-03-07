import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { authRoutes } from "../src/routes/auth";
import { reportRoutes } from "../src/routes/reports";
import { storageRoutes } from "../src/routes/storage";

// Build the Fastify app
export function buildApp() {
    const app = Fastify({
        logger: true,
        bodyLimit: 6 * 1024 * 1024, // 6MB max body (for base64 photo uploads)
    });

    // Security headers
    app.register(helmet, {
        contentSecurityPolicy: false, // Allow Vercel/browser dev tools
    });

    // CORS — restrict to frontend origin
    const allowedOrigins = [
        process.env.FRONTEND_URL,
        "http://localhost:8080",
        "http://192.168.100.4:8080", // Local network access
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
        allowedHeaders: ["Content-Type", "Authorization"],
    });

    // Health check
    app.get("/api/health", async () => {
        return { status: "ok", timestamp: new Date().toISOString() };
    });

    // Register routes
    app.register(authRoutes);
    app.register(reportRoutes);
    app.register(storageRoutes);

    // Global error handler
    app.setErrorHandler((error: any, request, reply) => {
        app.log.error(error);
        const statusCode = error.statusCode || 500;
        reply.code(statusCode).send({
            error: statusCode >= 500 ? "Internal server error" : error.message,
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
