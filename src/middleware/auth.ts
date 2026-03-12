import { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";

export interface AuthUser {
    id: string;
    email: string;
    role: string;
    fullName: string;
}

declare module "fastify" {
    interface FastifyRequest {
        user?: AuthUser;
    }
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required");
}

/**
 * Fastify preHandler hook — verifies JWT from Authorization header
 * and attaches decoded user to request.
 */
export async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
) {
    try {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return reply.code(401).send({ error: "Missing or invalid authorization header" });
        }

        const token = authHeader.substring(7);
        const decoded = (jwt.verify(token, JWT_SECRET!) as unknown) as AuthUser;

        request.user = {
            id: decoded.id,
            email: decoded.email,
            role: decoded.role,
            fullName: decoded.fullName,
        };
    } catch (err) {
        return reply.code(401).send({ error: "Invalid or expired token" });
    }
}

/**
 * Factory for role-checking preHandler hooks.
 * Usage: { preHandler: [authenticate, requireRole("manager")] }
 */
export function requireRole(...roles: string[]) {
    return async function (request: FastifyRequest, reply: FastifyReply) {
        if (!request.user) {
            return reply.code(401).send({ error: "Not authenticated" });
        }
        if (!roles.includes(request.user.role)) {
            return reply
                .code(403)
                .send({ error: `Access denied. Required role: ${roles.join(" or ")}` });
        }
    };
}
