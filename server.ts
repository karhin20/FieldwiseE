/**
 * Standalone server entry point for local development and Render deployment.
 * For Vercel, use api/index.ts instead.
 */
import "dotenv/config";
import { buildApp } from "./api/index";

const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = "0.0.0.0"; // Required for Render/Docker

async function start() {
    const app = buildApp();

    try {
        await app.listen({ port: PORT, host: HOST });
        console.log(`🚀 Server running at http://localhost:${PORT}`);
        console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

start();
